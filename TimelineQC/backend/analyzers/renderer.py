import os
import shutil
import subprocess
import tempfile
import time
from datetime import datetime


class LowResRenderer:
    RENDER_PRESETS = ("H.264 Main", "H.264 Master", "YouTube 1080p")

    def __init__(self, resolve, project, timeline):
        self.resolve = resolve
        self.project = project
        self.timeline = timeline

    def render(self, target_height=960, timeline_info=None):
        work_dir = tempfile.mkdtemp(prefix="moteline_short_drama_")
        render_dir = os.path.join(work_dir, "render")
        frames_dir = os.path.join(work_dir, "frames")
        os.makedirs(render_dir, exist_ok=True)
        os.makedirs(frames_dir, exist_ok=True)

        custom_name = "moteline_{}".format(datetime.now().strftime("%Y%m%d_%H%M%S"))
        self._prepare_render_format()
        self._load_best_preset()

        render_settings = self._build_render_settings(
            render_dir,
            custom_name,
            target_height,
            timeline_info or {},
        )

        try:
            if not self.project.SetRenderSettings(render_settings):
                return {"error": "Failed to apply render settings", "work_dir": work_dir}
        except Exception as e:
            return {"error": "Failed to apply render settings: {}".format(str(e)), "work_dir": work_dir}

        job_id = None
        try:
            job_id = self.project.AddRenderJob()
            if not job_id:
                return {"error": "Failed to add render job", "work_dir": work_dir}
        except Exception as e:
            return {"error": "Failed to add render job: {}".format(str(e)), "work_dir": work_dir}

        try:
            started = self.project.StartRendering(job_id)
            if not started:
                return {"error": "Failed to start rendering", "work_dir": work_dir}
        except Exception as e:
            return {"error": "Failed to start rendering: {}".format(str(e)), "work_dir": work_dir}

        render_status = self._wait_for_render(job_id)
        if render_status.get("error"):
            return {
                "error": render_status["error"],
                "work_dir": work_dir,
                "render_status": render_status,
            }

        rendered_file = self._find_rendered_file(render_dir)
        if rendered_file is None:
            return {
                "error": "Render completed but no output file found",
                "work_dir": work_dir,
                "render_dir": render_dir,
            }

        ffmpeg_path = self._find_ffmpeg()
        if not ffmpeg_path:
            return {
                "error": "FFmpeg not found; frame analysis requires FFmpeg",
                "work_dir": work_dir,
                "rendered_file": rendered_file,
            }

        extract_result = self._extract_frames_ffmpeg(ffmpeg_path, rendered_file, frames_dir, target_height)
        if not extract_result:
            return {
                "error": "Failed to extract frames with FFmpeg",
                "work_dir": work_dir,
                "rendered_file": rendered_file,
            }

        self._delete_render_job(job_id)
        return {
            "frames_dir": frames_dir,
            "rendered_file": rendered_file,
            "work_dir": work_dir,
            "render_status": render_status,
        }

    def _prepare_render_format(self):
        candidates = (
            ("mp4", "H264"),
            ("mp4", "h264"),
            ("mp4", "H.264"),
            ("mov", "H264"),
            ("mov", "H.264"),
        )
        for render_format, codec in candidates:
            try:
                if self.project.SetCurrentRenderFormatAndCodec(render_format, codec):
                    return True
            except Exception:
                continue
        return False

    def _load_best_preset(self):
        for preset in self.RENDER_PRESETS:
            try:
                if self.project.LoadRenderPreset(preset):
                    return True
            except Exception:
                continue
        return False

    def _build_render_settings(self, render_dir, custom_name, target_height, timeline_info):
        width = self._to_int(timeline_info.get("width"))
        height = self._to_int(timeline_info.get("height"))
        render_width, render_height = self._analysis_resolution(width, height, target_height)

        settings = {
            "SelectAllFrames": False,
            "MarkIn": self.timeline.GetStartFrame(),
            "MarkOut": self.timeline.GetEndFrame(),
            "TargetDir": render_dir,
            "CustomName": custom_name,
            "ExportVideo": True,
            "ExportAudio": False,
            "FormatWidth": render_width,
            "FormatHeight": render_height,
            "VideoQuality": "Least",
            "ReplaceExistingFilesInPlace": True,
        }

        frame_rate = timeline_info.get("frame_rate")
        if frame_rate:
            try:
                settings["FrameRate"] = float(frame_rate)
            except Exception:
                pass

        return settings

    def _analysis_resolution(self, width, height, target_height):
        if not width or not height:
            return 540, target_height

        if height >= width:
            render_height = target_height
            render_width = int(round(render_height * (width / float(height))))
        else:
            render_width = target_height
            render_height = int(round(render_width * (height / float(width))))

        return self._even(max(2, render_width)), self._even(max(2, render_height))

    def _wait_for_render(self, job_id, timeout_seconds=1800):
        started_at = time.time()
        last_status = {}

        while True:
            if time.time() - started_at > timeout_seconds:
                try:
                    self.project.StopRendering()
                except Exception:
                    pass
                return {"error": "Render timed out", "last_status": last_status}

            try:
                status = self.project.GetRenderJobStatus(job_id)
                if isinstance(status, dict):
                    last_status = status
                    status_text = str(
                        status.get("JobStatus")
                        or status.get("Status")
                        or status.get("status")
                        or ""
                    ).lower()
                    if "failed" in status_text or "error" in status_text:
                        return {"error": "Render failed: {}".format(status), "last_status": status}
                    if "complete" in status_text:
                        return {"status": status}
            except Exception:
                pass

            try:
                if not self.project.IsRenderingInProgress():
                    return {"status": last_status or {"JobStatus": "Complete"}}
            except Exception:
                return {"status": last_status}

            time.sleep(0.5)

    def _delete_render_job(self, job_id):
        try:
            self.project.DeleteRenderJob(job_id)
        except Exception:
            pass

    def _find_rendered_file(self, directory):
        candidates = []
        for root, _, files in os.walk(directory):
            for file_name in files:
                ext = os.path.splitext(file_name)[1].lower()
                if ext in (".mp4", ".mov", ".mkv", ".avi"):
                    path = os.path.join(root, file_name)
                    candidates.append((os.path.getmtime(path), path))
        if not candidates:
            return None
        candidates.sort(reverse=True)
        return candidates[0][1]

    def _find_ffmpeg(self):
        env_path = os.environ.get("FFMPEG_PATH")
        plugin_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        common_paths = [
            env_path,
            os.path.join(plugin_root, "runtime", "ffmpeg", "bin", "ffmpeg.exe"),
            os.path.join(plugin_root, "runtime", "ffmpeg", "ffmpeg.exe"),
            shutil.which("ffmpeg"),
            "C:\\ffmpeg\\bin\\ffmpeg.exe",
            "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
            "/opt/homebrew/bin/ffmpeg",
            "/opt/local/bin/ffmpeg",
            "/usr/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
        ]
        for path in common_paths:
            if not path:
                continue
            try:
                result = subprocess.run(
                    [path, "-version"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=5,
                )
                if result.returncode == 0:
                    return path
            except Exception:
                continue
        return None

    def _extract_frames_ffmpeg(self, ffmpeg_path, video_file, output_dir, target_height):
        output_pattern = os.path.join(output_dir, "frame_%06d.png")
        scale_filter = "scale=-2:{}".format(target_height)
        try:
            cmd = [
                ffmpeg_path,
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                video_file,
                "-vf",
                scale_filter,
                "-vsync",
                "0",
                "-y",
                output_pattern,
            ]
            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=900,
            )
            return result.returncode == 0
        except Exception:
            return False

    def _to_int(self, value):
        try:
            return int(float(value))
        except Exception:
            return None

    def _even(self, value):
        value = int(value)
        return value if value % 2 == 0 else value + 1
