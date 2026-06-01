import glob
import os


class OverexposureAnalyzer:
    def __init__(
        self,
        frames_dir,
        mean_threshold=0.82,
        bright_ratio_threshold=0.28,
        p95_threshold=0.97,
        min_duration_frames=3,
    ):
        self.frames_dir = frames_dir
        self.mean_threshold = self._normalize_threshold(mean_threshold, 0.82)
        self.bright_ratio_threshold = max(0.0, float(bright_ratio_threshold))
        self.p95_threshold = self._normalize_threshold(p95_threshold, 0.97)
        self.min_duration_frames = max(1, int(min_duration_frames))

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

        sequence_start = None
        sequence_count = 0

        for idx, frame_path in enumerate(frames):
            is_overexposed = self._is_frame_overexposed(frame_path, use_numpy)
            if is_overexposed:
                if sequence_start is None:
                    sequence_start = idx
                sequence_count += 1
            else:
                if sequence_start is not None and sequence_count >= self.min_duration_frames:
                    results.append(self._build_issue(sequence_start, sequence_count, idx - 1))
                sequence_start = None
                sequence_count = 0

        if sequence_start is not None and sequence_count >= self.min_duration_frames:
            results.append(self._build_issue(sequence_start, sequence_count, len(frames) - 1))

        return results

    def _build_issue(self, start_frame, duration, end_frame):
        return {
            "type": "overexposure",
            "frame": start_frame,
            "duration_frames": duration,
            "severity": "warning",
            "detection_mode": "precise_visual",
            "note": "过曝持续{}帧 (帧{}-{})".format(duration, start_frame, end_frame),
        }

    def _is_frame_overexposed(self, frame_path, use_numpy=False):
        if use_numpy:
            return self._check_numpy(frame_path)
        return self._check_pure_python(frame_path)

    def _check_numpy(self, frame_path):
        try:
            from PIL import Image
            import numpy as np

            img = Image.open(frame_path).convert("RGB")
            arr = np.asarray(img, dtype=np.float32) / 255.0
            gray = (
                arr[:, :, 0] * 0.2126
                + arr[:, :, 1] * 0.7152
                + arr[:, :, 2] * 0.0722
            )
            mean_val = float(np.mean(gray))
            p05 = float(np.percentile(gray, 5))
            p95 = float(np.percentile(gray, 95))
            bright_ratio = float(np.mean(gray >= (235 / 255.0)))
            clipped_ratio = float(np.mean(gray >= (250 / 255.0)))
            saturation = self._saturation_ratio(arr)
            is_overexposed = self._is_overexposed_stats(mean_val, bright_ratio, p05, p95, saturation, clipped_ratio)
            return is_overexposed
        except Exception:
            return False

    def _check_pure_python(self, frame_path):
        try:
            from PIL import Image

            img = Image.open(frame_path).convert("RGB")
            pixels = list(img.getdata())
            total = len(pixels)
            if total == 0:
                return False

            sample_step = max(1, total // 1200)
            sampled = pixels[::sample_step]
            if not sampled:
                return False

            gray_values = [self._luma(pixel) for pixel in sampled]
            mean_val = sum(gray_values) / len(gray_values)
            sorted_values = sorted(gray_values)
            p05 = sorted_values[int((len(sorted_values) - 1) * 0.05)]
            p95 = sorted_values[int((len(sorted_values) - 1) * 0.95)]
            bright_ratio = sum(1 for value in gray_values if value >= (235 / 255.0)) / len(gray_values)
            clipped_ratio = sum(1 for value in gray_values if value >= (250 / 255.0)) / len(gray_values)
            saturation = sum(self._saturation(pixel) for pixel in sampled) / len(sampled)
            return self._is_overexposed_stats(mean_val, bright_ratio, p05, p95, saturation, clipped_ratio)
        except Exception:
            return False

    def _is_overexposed_stats(self, mean_val, bright_ratio, p05, p95, saturation, clipped_ratio=0.0):
        strong_clip = (
            mean_val >= self.mean_threshold
            and bright_ratio >= self.bright_ratio_threshold
            and p95 >= self.p95_threshold
        )
        localized_clip = (
            mean_val >= max(0.66, self.mean_threshold - 0.12)
            and bright_ratio >= max(0.12, self.bright_ratio_threshold * 0.5)
            and p95 >= max(0.98, self.p95_threshold)
            and p05 >= 0.22
            and saturation <= 0.42
        )
        clipped_highlight = (
            clipped_ratio >= 0.035
            and p95 >= max(0.985, self.p95_threshold)
            and mean_val >= max(0.58, self.mean_threshold - 0.18)
            and saturation <= 0.48
        )
        return strong_clip or localized_clip or clipped_highlight

    def _saturation_ratio(self, arr):
        try:
            import numpy as np

            max_rgb = np.max(arr, axis=2)
            min_rgb = np.min(arr, axis=2)
            with np.errstate(divide="ignore", invalid="ignore"):
                saturation = np.where(max_rgb <= 0, 0, (max_rgb - min_rgb) / max_rgb)
            return float(np.mean(saturation))
        except Exception:
            return 0.0

    def _saturation(self, pixel):
        r, g, b = pixel
        rn = r / 255.0
        gn = g / 255.0
        bn = b / 255.0
        max_rgb = max(rn, gn, bn)
        min_rgb = min(rn, gn, bn)
        if max_rgb <= 0:
            return 0.0
        return (max_rgb - min_rgb) / max_rgb

    def _luma(self, pixel):
        r, g, b = pixel
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0

    def _normalize_threshold(self, value, fallback):
        try:
            parsed = float(value)
            if parsed > 1:
                return parsed / 255.0
            return parsed
        except Exception:
            return fallback
