import os
import glob


class BlackFrameAnalyzer:
    def __init__(
        self,
        frames_dir,
        threshold=18,
        min_duration_frames=1,
        detect_screen=False,
        screen_min_frames=8,
        dark_ratio_threshold=0.94,
        highlight_threshold=62,
    ):
        self.frames_dir = frames_dir
        self.threshold = threshold
        self.min_duration_frames = min_duration_frames
        self.detect_screen = detect_screen
        self.screen_min_frames = screen_min_frames
        self.dark_ratio_threshold = dark_ratio_threshold
        self.highlight_threshold = highlight_threshold

    def analyze(self):
        results = []
        frames = sorted(glob.glob(os.path.join(self.frames_dir, "frame_*.png")))
        if not frames:
            frames = sorted(glob.glob(os.path.join(self.frames_dir, "*.png")))
        if not frames:
            return results

        try:
            from PIL import Image
            import numpy as np
            use_numpy = True
        except ImportError:
            use_numpy = False

        black_sequence_start = None
        black_sequence_count = 0

        for idx, frame_path in enumerate(frames):
            is_black, stats = self._is_frame_black(frame_path, use_numpy)

            if is_black:
                if black_sequence_start is None:
                    black_sequence_start = idx
                black_sequence_count += 1
            else:
                if black_sequence_start is not None:
                    if black_sequence_count >= self.min_duration_frames:
                        results.append(self._build_black_issue(black_sequence_start, black_sequence_count, idx - 1))
                    black_sequence_start = None
                    black_sequence_count = 0

        if black_sequence_start is not None and black_sequence_count >= self.min_duration_frames:
            results.append(self._build_black_issue(black_sequence_start, black_sequence_count, len(frames) - 1))

        return results

    def _build_black_issue(self, start_frame, duration, end_frame):
        if self.detect_screen and duration >= self.screen_min_frames:
            return {
                "type": "black_screen",
                "frame": start_frame,
                "duration_frames": duration,
                "severity": "error",
                "detection_mode": "precise_visual",
                "note": "黑场持续{}帧 (帧{}-{})".format(duration, start_frame, end_frame),
            }

        return {
            "type": "black_frame",
            "frame": start_frame,
            "duration_frames": duration,
            "severity": "error",
            "detection_mode": "precise_visual",
            "note": "黑帧持续{}帧 (帧{}-{})".format(duration, start_frame, end_frame),
        }

    def _is_frame_black(self, frame_path, use_numpy=False):
        if use_numpy:
            return self._check_black_numpy(frame_path)
        return self._check_black_pure_python(frame_path)

    def _check_black_numpy(self, frame_path):
        try:
            from PIL import Image
            import numpy as np

            img = Image.open(frame_path).convert("L")
            arr = np.array(img)
            mean_val = float(np.mean(arr))
            dark_ratio = float(np.mean(arr <= self.highlight_threshold))
            p95 = float(np.percentile(arr, 95))
            is_black = (
                mean_val <= self.threshold
                and dark_ratio >= self.dark_ratio_threshold
                and p95 <= self.highlight_threshold
            )
            return is_black, {
                "mean": round(mean_val, 2),
                "dark_ratio": round(dark_ratio, 4),
                "p95": round(p95, 2),
            }
        except Exception:
            return self._check_black_pure_python(frame_path)

    def _check_black_pure_python(self, frame_path):
        try:
            from PIL import Image

            img = Image.open(frame_path).convert("L")
            pixels = list(img.getdata())
            total = len(pixels)
            if total == 0:
                return True, {"mean": 0, "dark_ratio": 1, "p95": 0}
            sample_step = max(1, total // 1000)
            sampled = pixels[::sample_step]
            avg = sum(sampled) / len(sampled)
            dark_count = sum(1 for p in sampled if p <= self.highlight_threshold)
            dark_ratio = dark_count / len(sampled)
            sorted_pixels = sorted(sampled)
            p95 = sorted_pixels[int((len(sorted_pixels) - 1) * 0.95)]
            is_black = (
                avg <= self.threshold
                and dark_ratio >= self.dark_ratio_threshold
                and p95 <= self.highlight_threshold
            )
            return is_black, {
                "mean": round(avg, 2),
                "dark_ratio": round(dark_ratio, 4),
                "p95": round(p95, 2),
            }
        except Exception:
            return False, {}
