import json
import os
import re
import shutil
import sys
from datetime import datetime

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

RESOLVE_SCRIPT_MODULE_CANDIDATES = [
    os.environ.get("RESOLVE_SCRIPT_MODULES", ""),
    os.path.join(
        os.environ.get("PROGRAMDATA", r"C:\ProgramData"),
        "Blackmagic Design",
        "DaVinci Resolve",
        "Support",
        "Developer",
        "Scripting",
        "Modules",
    ),
    r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\Modules",
]

for module_dir in RESOLVE_SCRIPT_MODULE_CANDIDATES:
    if module_dir and os.path.isdir(module_dir) and module_dir not in sys.path:
        sys.path.append(module_dir)

from analyzers.black_frame import BlackFrameAnalyzer
from analyzers.audio import MonoAudioAnalyzer
from analyzers.flash_frame import FlashFrameAnalyzer
from analyzers.exposure import OverexposureAnalyzer
from analyzers.renderer import LowResRenderer
from analyzers.short_drama import ShortDramaTimelineAnalyzer
from analyzers.ungraded import UngradedAnalyzer

try:
    import DaVinciResolveScript as dvr_script
except ImportError:
    dvr_script = None


class MoteLine:
    APP_DISPLAY_NAME = "鸡腿快助手"
    ISSUE_TYPES = {
        "black_frame": {"label": "黑帧", "marker_color": "Red"},
        "black_screen": {"label": "黑场", "marker_color": "Purple"},
        "flash_frame": {"label": "夹帧", "marker_color": "Sand"},
        "ungraded": {"label": "未调色", "marker_color": "Yellow"},
        "overexposure": {"label": "过曝", "marker_color": "Green"},
        "mono_audio": {"label": "单声道", "marker_color": "Pink"},
        "micro_clip": {"label": "夹帧", "marker_color": "Sand"},
        "format_warning": {"label": "格式", "marker_color": "Cyan"},
    }

    DEFAULT_CHECK_TYPES = [
        "short_drama_structure",
        "black_frame",
        "black_screen",
        "flash_frame",
        "ungraded",
        "overexposure",
        "mono_audio",
    ]

    def __init__(self):
        self.resolve = None
        self.project_manager = None
        self.project = None
        self.timeline = None
        self.timeline_start_frame = 0
        self.results = []
        self._connect_resolve()

    def _connect_resolve(self):
        if dvr_script is None:
            return

        for app_name in ("Resolve", self.APP_DISPLAY_NAME, "MoteLine", "TimelineQC"):
            try:
                self.resolve = dvr_script.scriptapp(app_name)
            except Exception:
                self.resolve = None
            if self.resolve is not None:
                break

        if self.resolve is None:
            return
        self.project_manager = self.resolve.GetProjectManager()
        if self.project_manager is None:
            return
        self.project = self.project_manager.GetCurrentProject()

    def _ensure_timeline(self):
        if self.project is None:
            self._connect_resolve()
        if self.project is None:
            return False

        self.timeline = self.project.GetCurrentTimeline()
        if self.timeline is None:
            tl_count = self.project.GetTimelineCount()
            if tl_count > 0:
                self.timeline = self.project.GetTimelineByIndex(1)

        if self.timeline is None:
            return False

        self.timeline_start_frame = self._safe_int(self.timeline.GetStartFrame(), 0)
        return True

    def get_timeline_info(self):
        if not self._ensure_timeline():
            return {"error": "No timeline available"}

        width = self._safe_int(self.timeline.GetSetting("timelineResolutionWidth"), 0)
        height = self._safe_int(self.timeline.GetSetting("timelineResolutionHeight"), 0)
        start_frame = self._safe_int(self.timeline.GetStartFrame(), 0)
        end_frame = self._safe_int(self.timeline.GetEndFrame(), 0)
        aspect = round(width / float(height), 4) if width and height else None

        return {
            "name": self.timeline.GetName(),
            "start_frame": start_frame,
            "end_frame": end_frame,
            "duration_frames": max(0, end_frame - start_frame),
            "video_track_count": self.timeline.GetTrackCount("video"),
            "audio_track_count": self.timeline.GetTrackCount("audio"),
            "frame_rate": self.timeline.GetSetting("timelineFrameRate"),
            "width": width,
            "height": height,
            "resolution": "{}x{}".format(width, height) if width and height else "--",
            "aspect": aspect,
            "profile": "short_drama_vertical" if aspect and abs(aspect - (9 / 16)) <= 0.035 else "custom",
        }

    def _collect_all_clips(self):
        clips_info = []
        video_track_count = self.timeline.GetTrackCount("video")
        for track_idx in range(1, video_track_count + 1):
            track_enabled = self._is_track_enabled("video", track_idx)
            track_name = self.timeline.GetTrackName("video", track_idx)
            clips = self.timeline.GetItemListInTrack("video", track_idx)
            if not clips:
                continue

            for clip in clips:
                try:
                    raw_start = self._safe_int(clip.GetStart(), 0)
                    raw_end = self._safe_int(clip.GetEnd(), raw_start)
                    start_frame = self._normalize_timeline_frame(raw_start)
                    end_frame = self._normalize_timeline_frame(raw_end)
                    duration = self._safe_int(clip.GetDuration(), max(0, end_frame - start_frame))
                    if duration <= 0 and end_frame > start_frame:
                        duration = end_frame - start_frame

                    clip_data = {
                        "clip": clip,
                        "track_index": track_idx,
                        "track_name": track_name,
                        "track_enabled": track_enabled,
                        "enabled": track_enabled and self._is_clip_enabled(clip),
                        "name": clip.GetName(),
                        "start": raw_start,
                        "end": raw_end,
                        "start_frame": start_frame,
                        "end_frame": end_frame,
                        "left_offset": self._call_optional(clip, "GetLeftOffset", 0),
                        "right_offset": self._call_optional(clip, "GetRightOffset", 0),
                        "duration": duration,
                        "media_type": self._get_media_type(clip),
                    }
                    clips_info.append(clip_data)
                except Exception:
                    continue

        return clips_info

    def _collect_audio_clips(self):
        clips_info = []
        audio_track_count = self._safe_int(self.timeline.GetTrackCount("audio"), 0)

        for track_idx in range(1, audio_track_count + 1):
            track_enabled = self._is_track_enabled("audio", track_idx)
            track_name = self._call_track_optional("GetTrackName", "audio", track_idx, default="")
            track_format = self._call_track_optional("GetTrackFormat", "audio", track_idx, default="")
            track_type = self._call_track_optional("GetTrackType", "audio", track_idx, default="")
            clips = self.timeline.GetItemListInTrack("audio", track_idx)
            if not clips:
                continue

            for clip in clips:
                try:
                    raw_start = self._safe_int(clip.GetStart(), 0)
                    raw_end = self._safe_int(clip.GetEnd(), raw_start)
                    start_frame = self._normalize_timeline_frame(raw_start)
                    end_frame = self._normalize_timeline_frame(raw_end)
                    duration = self._safe_int(clip.GetDuration(), max(0, end_frame - start_frame))
                    if duration <= 0 and end_frame > start_frame:
                        duration = end_frame - start_frame

                    media_pool_item = self._call_optional(clip, "GetMediaPoolItem", None)
                    clip_properties = self._safe_dict(self._call_optional(media_pool_item, "GetClipProperty", {})) if media_pool_item else {}
                    item_properties = self._safe_dict(self._call_optional(clip, "GetProperty", {}))

                    clip_data = {
                        "clip": clip,
                        "track_index": track_idx,
                        "track_name": track_name,
                        "track_format": track_format,
                        "track_type": track_type,
                        "track_enabled": track_enabled,
                        "enabled": track_enabled and self._is_clip_enabled(clip),
                        "name": self._call_optional(clip, "GetName", "Unknown"),
                        "start": raw_start,
                        "end": raw_end,
                        "start_frame": start_frame,
                        "end_frame": end_frame,
                        "duration": duration,
                        "clip_properties": clip_properties,
                        "item_properties": item_properties,
                    }
                    clips_info.append(clip_data)
                except Exception:
                    continue

        return clips_info

    def run_check(self, options):
        if not self._ensure_timeline():
            return {"error": "No timeline available"}

        self.results = []
        options = self._short_drama_defaults(options or {})
        timeline_info = self.get_timeline_info()
        clips_info = self._collect_all_clips()
        check_types = options.get("check_types", self.DEFAULT_CHECK_TYPES)
        audio_clips_info = self._collect_audio_clips() if "mono_audio" in check_types else []

        frames_dir = ""
        work_dir = ""
        render_result = {}

        if "short_drama_structure" in check_types:
            analyzer = ShortDramaTimelineAnalyzer(
                timeline_info=timeline_info,
                clips_info=clips_info,
                max_micro_clip_frames=options.get("micro_clip_max_frames", 3),
            )
            self.results.extend(analyzer.analyze())

        needs_render = self._needs_render(check_types)
        if needs_render:
            if options.get("render_enabled", True):
                renderer = LowResRenderer(self.resolve, self.project, self.timeline)
                render_result = renderer.render(
                    target_height=options.get("render_height", 960),
                    timeline_info=timeline_info,
                )
                if render_result.get("error"):
                    return render_result
                frames_dir = render_result["frames_dir"]
                work_dir = render_result.get("work_dir", "")
            else:
                frames_dir = options.get("frames_dir", "")

        if frames_dir and ("black_frame" in check_types or "black_screen" in check_types):
            analyzer = BlackFrameAnalyzer(
                frames_dir=frames_dir,
                threshold=options.get("black_threshold", 18),
                min_duration_frames=1 if "black_frame" in check_types else options.get("black_screen_min_frames", 8),
                detect_screen="black_screen" in check_types,
                screen_min_frames=options.get("black_screen_min_frames", 8),
                dark_ratio_threshold=options.get("black_dark_ratio", 0.94),
                highlight_threshold=options.get("black_highlight_threshold", 62),
            )
            self.results.extend(analyzer.analyze())

        if frames_dir and "overexposure" in check_types:
            analyzer = OverexposureAnalyzer(
                frames_dir=frames_dir,
                mean_threshold=options.get("overexposure_luma_threshold", 0.82),
                bright_ratio_threshold=options.get("overexposure_bright_ratio", 0.28),
                p95_threshold=options.get("overexposure_p95_threshold", 0.97),
                min_duration_frames=options.get("overexposure_min_frames", 3),
            )
            self.results.extend(analyzer.analyze())

        if frames_dir and "flash_frame" in check_types:
            analyzer = FlashFrameAnalyzer(
                frames_dir=frames_dir,
                threshold=options.get("flash_threshold", 0.28),
                min_duration=options.get("flash_min_frames", 3),
                return_threshold=options.get("flash_return_threshold", 0.12),
                black_luma_threshold=self._safe_int(options.get("black_threshold", 18), 18) / 255.0,
                black_dark_ratio_threshold=float(options.get("black_dark_ratio", 0.94)),
                black_highlight_threshold=self._safe_int(options.get("black_highlight_threshold", 62), 62) / 255.0,
            )
            self.results.extend(analyzer.analyze())

        if "ungraded" in check_types:
            analyzer = UngradedAnalyzer(
                clips_info=clips_info,
                frames_dir=frames_dir,
                min_clip_frames=options.get("ungraded_min_clip_frames", 8),
            )
            self.results.extend(analyzer.analyze())

        if "mono_audio" in check_types:
            analyzer = MonoAudioAnalyzer(audio_clips_info)
            self.results.extend(analyzer.analyze())

        self.results = self._dedupe_results(self.results)

        if options.get("add_markers", True):
            self._add_markers()

        report = self._generate_report(timeline_info, options, render_result)

        if work_dir and options.get("render_enabled", True) and options.get("cleanup_frames", True):
            shutil.rmtree(work_dir, ignore_errors=True)

        return report

    def _short_drama_defaults(self, options):
        defaults = {
            "check_types": self.DEFAULT_CHECK_TYPES,
            "black_threshold": 18,
            "black_screen_min_frames": 8,
            "black_dark_ratio": 0.94,
            "black_highlight_threshold": 62,
            "overexposure_luma_threshold": 0.82,
            "overexposure_bright_ratio": 0.28,
            "overexposure_p95_threshold": 0.97,
            "overexposure_min_frames": 3,
            "flash_threshold": 0.28,
            "flash_return_threshold": 0.12,
            "flash_min_frames": 3,
            "micro_clip_max_frames": 3,
            "ungraded_min_clip_frames": 8,
            "render_height": 960,
            "add_markers": True,
            "cleanup_frames": True,
            "render_enabled": True,
        }
        merged = defaults.copy()
        merged.update(options)
        return merged

    def _needs_render(self, check_types):
        return bool(
            {"black_frame", "black_screen", "flash_frame", "ungraded", "overexposure"}.intersection(check_types)
        )

    def _add_markers(self):
        for issue in self.results:
            issue_type = self._canonical_issue_type(issue.get("type", ""))
            meta = self.ISSUE_TYPES.get(issue_type, {})
            color = meta.get("marker_color", "Red")
            label = meta.get("label", issue_type)
            frame = self._safe_int(issue.get("frame", 0), 0)
            duration = self._marker_duration(issue)
            note = issue.get("note", "")
            confidence = issue.get("confidence")
            if confidence is not None:
                note = "{}；置信度 {:.0%}".format(note, float(confidence))

            marker_name = "{}: {}".format(self.APP_DISPLAY_NAME, label)
            marker_note = "[{}][短剧] {}".format(self.APP_DISPLAY_NAME, note)
            custom_data = "MoteLine:{}:{}".format(issue_type, frame)

            try:
                self.timeline.AddMarker(
                    frame,
                    color,
                    marker_name,
                    marker_note,
                    duration,
                    custom_data,
                )
            except Exception:
                try:
                    self.timeline.AddMarker(frame, color, marker_name, marker_note, duration)
                except Exception:
                    pass

    def _generate_report(self, timeline_info, options, render_result=None):
        summary = {
            "scenario": "short_drama",
            "timeline": timeline_info,
            "check_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "options": options,
            "render": self._clean_render_result(render_result or {}),
            "total_issues": len(self.results),
            "issues_by_type": {},
            "issues_by_severity": {},
        }

        for issue in self.results:
            issue_type = self._canonical_issue_type(issue.get("type", "unknown"))
            severity = issue.get("severity", "warning")
            summary["issues_by_type"][issue_type] = summary["issues_by_type"].get(issue_type, 0) + 1
            summary["issues_by_severity"][severity] = summary["issues_by_severity"].get(severity, 0) + 1

        summary["issues"] = self.results

        report_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "reports")
        os.makedirs(report_dir, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        tl_name = self._sanitize_file_name(timeline_info.get("name", "unknown"))
        report_file = os.path.join(report_dir, "{}_{}_{}.json".format(self.APP_DISPLAY_NAME, tl_name, timestamp))

        with open(report_file, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

        summary["report_file"] = report_file
        return summary

    def clear_markers(self):
        if not self._ensure_timeline():
            return {"error": "No timeline available"}
        try:
            markers = self.timeline.GetMarkers() or {}
            targets = []
            if isinstance(markers, dict):
                for frame, marker_data in list(markers.items()):
                    if self._is_timelineqc_marker(marker_data):
                        targets.append((frame, marker_data))

            for frame, marker_data in targets:
                self._delete_timelineqc_marker(frame, marker_data)

            remaining_markers = self.timeline.GetMarkers() or {}
            remaining = self._count_timelineqc_markers(remaining_markers)
            cleared = max(0, len(targets) - remaining)
            return {
                "status": "ok",
                "message": "{} markers cleared".format(self.APP_DISPLAY_NAME),
                "attempted": len(targets),
                "cleared": cleared,
                "remaining": remaining,
            }
        except Exception as e:
            return {"error": str(e)}

    def _delete_timelineqc_marker(self, frame, marker_data):
        deleted = False
        custom_data = self._marker_custom_data(marker_data)
        delete_by_custom_data = getattr(self.timeline, "DeleteMarkerByCustomData", None)
        if custom_data and callable(delete_by_custom_data):
            try:
                if delete_by_custom_data(custom_data) is not False:
                    deleted = True
            except Exception:
                pass

        delete_at_frame = getattr(self.timeline, "DeleteMarkerAtFrame", None)
        if callable(delete_at_frame):
            for candidate in self._marker_frame_candidates(frame):
                try:
                    if delete_at_frame(candidate) is not False:
                        deleted = True
                except Exception:
                    pass
        return deleted

    def _marker_frame_candidates(self, frame):
        candidates = []
        seen = set()
        try:
            base = int(float(frame))
        except Exception:
            return candidates

        for value in (base, int(base), int(round(base)), base + self.timeline_start_frame, base - self.timeline_start_frame):
            if value < 0 or value in seen:
                continue
            seen.add(value)
            candidates.append(value)
        return candidates

    def _marker_custom_data(self, marker_data):
        if not isinstance(marker_data, dict):
            return ""
        return str(
            marker_data.get("customData")
            or marker_data.get("customdata")
            or marker_data.get("custom_data")
            or ""
        ).strip()

    def _is_timelineqc_marker(self, marker_data):
        if not isinstance(marker_data, dict):
            return False
        name = str(marker_data.get("name", "") or "").strip().lower()
        note = str(marker_data.get("note", "") or "").strip().lower()
        custom_data = self._marker_custom_data(marker_data).lower()
        haystack = "{} {} {}".format(name, note, custom_data)
        return (
            name.startswith("qc:")
            or "timelineqc" in haystack
            or "moteline" in haystack
            or "鸡腿快助手" in haystack
            or "鸡腿大人" in haystack
            or "[qc]" in haystack
            or ("短剧" in note and "marker" in note)
        )

    def _count_timelineqc_markers(self, markers):
        if not isinstance(markers, dict):
            return 0
        return sum(1 for marker_data in markers.values() if self._is_timelineqc_marker(marker_data))

    def _dedupe_results(self, results):
        black_ranges = []
        black_screen_ranges = []
        for issue in results:
            issue_type = self._canonical_issue_type(issue.get("type", ""))
            if issue_type in ("black_frame", "black_screen"):
                start = self._safe_int(issue.get("frame", 0), 0)
                duration = self._safe_int(issue.get("duration_frames", 1), 1)
                item_range = (start, start + max(1, duration))
                black_ranges.append(item_range)
                if issue_type == "black_screen":
                    black_screen_ranges.append(item_range)

        filtered = []
        seen = set()
        for issue in sorted(results, key=self._issue_sort_key):
            issue_type = self._canonical_issue_type(issue.get("type", ""))
            start = self._safe_int(issue.get("frame", 0), 0)
            duration = self._safe_int(issue.get("duration_frames", 1), 1)
            end = start + max(1, duration)

            if issue_type == "flash_frame" and any(self._ranges_overlap_or_near((start, end), r, 1) for r in black_ranges):
                continue
            if issue_type == "black_frame" and any(self._ranges_overlap((start, end), r) for r in black_screen_ranges):
                continue

            key = (issue_type, start, duration, issue.get("clip_name", ""))
            if key in seen:
                continue
            seen.add(key)
            if issue_type != issue.get("type", ""):
                filtered.append(dict(issue, type=issue_type))
            else:
                filtered.append(issue)

        return filtered

    def _canonical_issue_type(self, issue_type):
        return "flash_frame" if issue_type == "micro_clip" else issue_type

    def _marker_duration(self, issue):
        issue_type = self._canonical_issue_type(issue.get("type", ""))
        duration = max(1, self._safe_int(issue.get("duration_frames", 1), self._safe_int(issue.get("duration", 1), 1)))
        if issue_type in ("flash_frame", "black_frame"):
            return 1
        if issue_type in ("black_screen", "ungraded", "overexposure", "mono_audio"):
            return duration
        return duration if duration >= 10 else 1

    def _issue_sort_key(self, issue):
        severity_rank = {"error": 0, "warning": 1, "info": 2}
        return (
            self._safe_int(issue.get("frame", 0), 0),
            severity_rank.get(issue.get("severity", "warning"), 1),
            issue.get("type", ""),
        )

    def _ranges_overlap(self, a, b):
        return a[0] < b[1] and b[0] < a[1]

    def _ranges_overlap_or_near(self, a, b, tolerance=1):
        if self._ranges_overlap(a, b):
            return True
        distance = b[0] - a[1] if a[1] <= b[0] else a[0] - b[1]
        return distance <= tolerance

    def _normalize_timeline_frame(self, frame):
        frame = self._safe_int(frame, 0)
        if frame >= self.timeline_start_frame:
            return frame - self.timeline_start_frame
        return frame

    def _is_track_enabled(self, track_type, track_idx):
        try:
            return bool(self.timeline.GetIsTrackEnabled(track_type, track_idx))
        except Exception:
            return True

    def _is_clip_enabled(self, clip):
        try:
            return bool(clip.GetClipEnabled())
        except Exception:
            return True

    def _get_media_type(self, clip):
        try:
            media_pool_item = clip.GetMediaPoolItem()
            if media_pool_item:
                props = media_pool_item.GetClipProperty()
                for key in ("Type", "Clip Type", "Video Codec"):
                    if props.get(key):
                        return str(props.get(key))
        except Exception:
            pass
        return ""

    def _call_optional(self, obj, method_name, default=None):
        if obj is None:
            return default
        try:
            return getattr(obj, method_name)()
        except Exception:
            return default

    def _call_track_optional(self, method_name, track_type, track_idx, default=None):
        try:
            return getattr(self.timeline, method_name)(track_type, track_idx)
        except Exception:
            return default

    def _safe_dict(self, value):
        return value if isinstance(value, dict) else {}

    def _safe_int(self, value, default=None):
        try:
            return int(float(value))
        except Exception:
            return default

    def _sanitize_file_name(self, value):
        value = str(value or "unknown").strip() or "unknown"
        value = re.sub(r'[\\/:*?"<>|]+', "_", value)
        return value.replace(" ", "_")[:80]

    def _clean_render_result(self, render_result):
        return {
            "rendered_file": render_result.get("rendered_file", ""),
            "frames_dir": render_result.get("frames_dir", ""),
        }


def handle_request(action, params=None):
    if params is None:
        params = {}

    if action == "analyze_frames":
        return analyze_frames(params)

    qc = MoteLine()

    if action == "get_timeline_info":
        return qc.get_timeline_info()
    if action == "run_check":
        return qc.run_check(params)
    if action == "clear_markers":
        return qc.clear_markers()
    return {"error": "Unknown action: {}".format(action)}


def analyze_frames(params):
    options = params.get("options", {})
    timeline_info = params.get("timeline_info", {})
    clips_info = params.get("clips_info", [])
    audio_clips_info = params.get("audio_clips_info", [])
    frames_dir = params.get("frames_dir", "")
    check_types = options.get("check_types", MoteLine.DEFAULT_CHECK_TYPES)
    results = []

    if "short_drama_structure" in check_types:
        analyzer = ShortDramaTimelineAnalyzer(
            timeline_info=timeline_info,
            clips_info=clips_info,
            max_micro_clip_frames=options.get("micro_clip_max_frames", 3),
        )
        results.extend(analyzer.analyze())

    if frames_dir and ("black_frame" in check_types or "black_screen" in check_types):
        analyzer = BlackFrameAnalyzer(
            frames_dir=frames_dir,
            threshold=options.get("black_threshold", 18),
            min_duration_frames=1 if "black_frame" in check_types else options.get("black_screen_min_frames", 8),
            detect_screen="black_screen" in check_types,
            screen_min_frames=options.get("black_screen_min_frames", 8),
            dark_ratio_threshold=options.get("black_dark_ratio", 0.94),
            highlight_threshold=options.get("black_highlight_threshold", 62),
        )
        results.extend(analyzer.analyze())

    if frames_dir and "overexposure" in check_types:
        analyzer = OverexposureAnalyzer(
            frames_dir=frames_dir,
            mean_threshold=options.get("overexposure_luma_threshold", 0.82),
            bright_ratio_threshold=options.get("overexposure_bright_ratio", 0.28),
            p95_threshold=options.get("overexposure_p95_threshold", 0.97),
            min_duration_frames=options.get("overexposure_min_frames", 3),
        )
        results.extend(analyzer.analyze())

    if frames_dir and "flash_frame" in check_types:
        analyzer = FlashFrameAnalyzer(
            frames_dir=frames_dir,
            threshold=options.get("flash_threshold", 0.28),
            min_duration=options.get("flash_min_frames", 3),
            return_threshold=options.get("flash_return_threshold", 0.12),
            black_luma_threshold=_safe_int(options.get("black_threshold", 18), 18) / 255.0,
            black_dark_ratio_threshold=float(options.get("black_dark_ratio", 0.94)),
            black_highlight_threshold=_safe_int(options.get("black_highlight_threshold", 62), 62) / 255.0,
        )
        results.extend(analyzer.analyze())

    if "ungraded" in check_types:
        analyzer = UngradedAnalyzer(
            clips_info=clips_info,
            frames_dir=frames_dir,
            min_clip_frames=options.get("ungraded_min_clip_frames", 8),
        )
        results.extend(analyzer.analyze())

    if "mono_audio" in check_types:
        analyzer = MonoAudioAnalyzer(audio_clips_info)
        results.extend(analyzer.analyze())

    results = _dedupe_plain_results(results)
    return _generate_plain_report(timeline_info, options, results)


def _dedupe_plain_results(results):
    black_ranges = []
    black_screen_ranges = []
    for issue in results:
        issue_type = _canonical_issue_type(issue.get("type", ""))
        if issue_type in ("black_frame", "black_screen"):
            start = _safe_int(issue.get("frame", 0), 0)
            duration = _safe_int(issue.get("duration_frames", 1), 1)
            item_range = (start, start + max(1, duration))
            black_ranges.append(item_range)
            if issue_type == "black_screen":
                black_screen_ranges.append(item_range)

    filtered = []
    seen = set()
    for issue in sorted(results, key=lambda item: (_safe_int(item.get("frame", 0), 0), _canonical_issue_type(item.get("type", "")))):
        issue_type = _canonical_issue_type(issue.get("type", ""))
        start = _safe_int(issue.get("frame", 0), 0)
        duration = _safe_int(issue.get("duration_frames", 1), 1)
        end = start + max(1, duration)
        if issue_type == "flash_frame" and any(_ranges_overlap_or_near((start, end), r, 1) for r in black_ranges):
            continue
        if issue_type == "black_frame" and any(start < r[1] and r[0] < end for r in black_screen_ranges):
            continue
        key = (issue_type, start, duration, issue.get("clip_name", ""))
        if key in seen:
            continue
        seen.add(key)
        if issue_type != issue.get("type", ""):
            filtered.append(dict(issue, type=issue_type))
        else:
            filtered.append(issue)
    return filtered


def _generate_plain_report(timeline_info, options, results):
    summary = {
        "scenario": "short_drama",
        "timeline": timeline_info,
        "check_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "options": options,
        "total_issues": len(results),
        "issues_by_type": {},
        "issues_by_severity": {},
        "issues": results,
    }

    for issue in results:
        issue_type = _canonical_issue_type(issue.get("type", "unknown"))
        severity = issue.get("severity", "warning")
        summary["issues_by_type"][issue_type] = summary["issues_by_type"].get(issue_type, 0) + 1
        summary["issues_by_severity"][severity] = summary["issues_by_severity"].get(severity, 0) + 1

    report_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "reports")
    os.makedirs(report_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    tl_name = re.sub(r'[\\/:*?"<>|]+', "_", str(timeline_info.get("name", "unknown"))).replace(" ", "_")[:80]
    report_file = os.path.join(report_dir, "{}_{}_{}.json".format(MoteLine.APP_DISPLAY_NAME, tl_name or "unknown", timestamp))

    with open(report_file, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    summary["report_file"] = report_file
    return summary


def _canonical_issue_type(issue_type):
    return "flash_frame" if issue_type == "micro_clip" else issue_type


def _safe_int(value, default=None):
    try:
        return int(float(value))
    except Exception:
        return default


def _ranges_overlap_or_near(a, b, tolerance=1):
    if a[0] < b[1] and b[0] < a[1]:
        return True
    distance = b[0] - a[1] if a[1] <= b[0] else a[0] - b[1]
    return distance <= tolerance


if __name__ == "__main__":
    if len(sys.argv) > 1:
        action = sys.argv[1]
        params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        result = handle_request(action, params)
        print(json.dumps(result, ensure_ascii=False))

