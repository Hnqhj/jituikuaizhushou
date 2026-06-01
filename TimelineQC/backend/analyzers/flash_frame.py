import glob
import os


class FlashFrameAnalyzer:
    """Detect short-drama flash/orphan frames without flagging normal cuts."""

    def __init__(
        self,
        frames_dir,
        threshold=0.28,
        min_duration=3,
        return_threshold=0.12,
        resize_width=96,
        cooldown_frames=3,
        black_luma_threshold=18 / 255.0,
        black_dark_ratio_threshold=0.94,
        black_highlight_threshold=62 / 255.0,
    ):
        self.frames_dir = frames_dir
        self.threshold = threshold
        self.min_duration = min_duration
        self.return_threshold = return_threshold
        self.resize_width = resize_width
        self.cooldown_frames = cooldown_frames
        self.black_luma_threshold = black_luma_threshold
        self.black_dark_ratio_threshold = black_dark_ratio_threshold
        self.black_highlight_threshold = black_highlight_threshold

    def analyze(self):
        results = []
        frames = self._list_frames()
        if len(frames) < 3:
            return results

        features = [self._get_frame_feature(frame_path) for frame_path in frames]
        last_hit_end = -1

        for idx in range(1, len(frames) - 1):
            if last_hit_end >= 0 and idx <= last_hit_end + self.cooldown_frames:
                continue

            candidate = self._match_orphan_run(idx, features, len(frames))
            if candidate is None:
                continue

            start, duration, break_score, return_score = candidate
            last_hit_end = start + duration - 1
            results.append({
                "type": "flash_frame",
                "frame": start,
                "duration_frames": duration,
                "diff_score": round(break_score, 4),
                "return_score": round(return_score, 4),
                "severity": "warning",
                "detection_mode": "precise_visual",
                "note": "疑似夹帧: 帧{}处出现{}帧异常画面，前后画面相似度高".format(
                    start, duration
                ),
            })

        return results

    def _list_frames(self):
        frames = sorted(glob.glob(os.path.join(self.frames_dir, "frame_*.png")))
        if not frames:
            frames = sorted(glob.glob(os.path.join(self.frames_dir, "*.png")))
        return frames

    def _match_orphan_run(self, start, features, frame_count):
        prev_feature = features[start - 1]
        if prev_feature is None:
            return None

        best = None
        max_duration = min(self.min_duration, frame_count - start - 1)
        for duration in range(1, max_duration + 1):
            end = start + duration - 1
            next_index = end + 1
            next_feature = features[next_index]
            first_feature = features[start]
            last_feature = features[end]

            if None in (next_feature, first_feature, last_feature):
                continue
            if self._is_black_feature(first_feature) or self._is_black_feature(last_feature):
                continue

            enter_score = self._feature_diff(prev_feature, first_feature)
            exit_score = self._feature_diff(last_feature, next_feature)
            return_score = self._feature_diff(prev_feature, next_feature)
            break_score = min(enter_score, exit_score)

            if break_score < self.threshold:
                continue
            if return_score > self.return_threshold:
                continue

            luminance_spike = self._luma_spike(prev_feature, first_feature, next_feature)
            if not luminance_spike and enter_score < self.threshold * 1.15:
                continue

            best = (start, duration, break_score, return_score)
            break

        return best

    def _get_frame_feature(self, frame_path):
        try:
            from PIL import Image
            import numpy as np

            img = Image.open(frame_path).convert("RGB")
            w, h = img.size
            if w <= 0 or h <= 0:
                return None
            resize_height = max(1, int(h * (self.resize_width / float(w))))
            img = img.resize((self.resize_width, resize_height), Image.BILINEAR)
            arr = np.asarray(img, dtype=np.float32) / 255.0
            gray = (
                arr[:, :, 0] * 0.2126
                + arr[:, :, 1] * 0.7152
                + arr[:, :, 2] * 0.0722
            )
            flat = gray.reshape(-1)
            return {
                "gray": gray,
                "mean": float(gray.mean()),
                "std": float(gray.std()),
                "p95": float(np.percentile(flat, 95)) if flat.size else 0.0,
                "dark_ratio": float(np.mean(flat <= self.black_highlight_threshold)) if flat.size else 0.0,
            }
        except Exception:
            return None

    def _feature_diff(self, a, b):
        try:
            import numpy as np

            if a["gray"].shape != b["gray"].shape:
                return 1.0
            pixel_diff = float(np.mean(np.abs(a["gray"] - b["gray"])))
            mean_diff = abs(a["mean"] - b["mean"])
            contrast_diff = abs(a["std"] - b["std"])
            return pixel_diff * 0.82 + mean_diff * 0.12 + contrast_diff * 0.06
        except Exception:
            return 1.0

    def _luma_spike(self, prev_feature, curr_feature, next_feature):
        curr_delta = max(
            abs(curr_feature["mean"] - prev_feature["mean"]),
            abs(curr_feature["mean"] - next_feature["mean"]),
        )
        neighbor_delta = abs(prev_feature["mean"] - next_feature["mean"])
        return curr_delta >= 0.18 and neighbor_delta <= 0.08

    def _is_black_feature(self, feature):
        if not feature:
            return False
        return (
            feature.get("mean", 1.0) <= self.black_luma_threshold
            and feature.get("dark_ratio", 0.0) >= self.black_dark_ratio_threshold
            and feature.get("p95", 1.0) <= self.black_highlight_threshold
        )
