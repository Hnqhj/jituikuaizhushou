import glob
import os
import statistics


class UngradedAnalyzer:
    def __init__(
        self,
        clips_info,
        frames_dir=None,
        sample_count=5,
        min_clip_frames=8,
    ):
        self.clips_info = clips_info
        self.frames_dir = frames_dir
        self.sample_count = sample_count
        self.min_clip_frames = min_clip_frames
        self.frames = self._list_frames()

    def analyze(self):
        results = []
        candidates = []

        for clip_data in self._top_visible_main_clips():
            if self._should_ignore_clip(clip_data):
                continue

            clip = clip_data.get("clip")
            grade_status = clip_data.get("grade_status")
            if clip is None and not grade_status:
                continue

            if not grade_status:
                grade_status = self._check_grade_status(clip)
            visual_stats = (
                clip_data.get("visual_stats")
                or clip_data.get("quick_visual_stats")
                or self._sample_clip_visual_stats(clip_data)
            )
            candidates.append((clip_data, grade_status, visual_stats))

        visual_pool = [stats for _, _, stats in candidates if stats]
        median_contrast = self._median_value(visual_pool, "contrast")
        median_saturation = self._median_value(visual_pool, "saturation")

        for clip_data, grade_status, visual_stats in candidates:
            verdict = self._build_verdict(
                grade_status,
                visual_stats,
                median_contrast,
                median_saturation,
            )
            if not verdict.get("ungraded"):
                continue

            results.append({
                "type": "ungraded",
                "frame": clip_data.get("start_frame", clip_data.get("start", 0)),
                "clip_name": clip_data.get("name", "Unknown"),
                "track_index": clip_data.get("track_index", 0),
                "track_name": clip_data.get("track_name", ""),
                "duration": clip_data.get("duration", 0),
                "duration_frames": clip_data.get("duration", 1),
                "confidence": verdict.get("confidence", 0.6),
                "severity": "warning",
                "detection_mode": "precise_visual" if visual_stats else "timeline_metadata",
                "note": "疑似未调色: {} (V{}) - {}".format(
                    clip_data.get("name", "Unknown"),
                    clip_data.get("track_index", 0),
                    verdict.get("reason", "未发现明确调色信号"),
                ),
            })

        return results

    def _list_frames(self):
        if not self.frames_dir:
            return []
        frames = sorted(glob.glob(os.path.join(self.frames_dir, "frame_*.png")))
        if not frames:
            frames = sorted(glob.glob(os.path.join(self.frames_dir, "*.png")))
        return frames

    def _should_ignore_clip(self, clip_data):
        if not clip_data.get("enabled", True) or clip_data.get("track_enabled", True) is False:
            return True

        duration = int(float(clip_data.get("duration", 0) or 0))
        if duration <= 0:
            return True

        return self._is_overlay_clip(clip_data)

    def _is_overlay_clip(self, clip_data):
        hint = clip_data.get("transition_hint") or {}
        graphic_hint = clip_data.get("graphic_overlay_hint") or {}
        metadata = clip_data.get("transition_metadata") or {}
        if metadata.get("has_transition"):
            return True
        try:
            if hint.get("is_transition") or float(hint.get("confidence", 0) or 0) >= 0.45:
                return True
        except Exception:
            pass
        try:
            if graphic_hint.get("is_graphic_overlay") or float(graphic_hint.get("confidence", 0) or 0) >= 0.5:
                return True
        except Exception:
            pass
        text = " ".join([
            str(clip_data.get("name", "")),
            str(clip_data.get("track_name", "")),
            str(clip_data.get("media_type", "")),
            str(clip_data.get("file_name", "")),
            str(clip_data.get("file_path", "")),
        ]).lower()
        track_index = self._to_int(clip_data.get("track_index", 0), 0)
        ext = os.path.splitext(str(clip_data.get("file_path") or clip_data.get("file_name") or ""))[1].lower()
        if track_index > 1 and ext == ".png":
            return True
        if ext in self._overlay_video_extensions():
            return False
        ignore_keywords = [
            "title",
            "text",
            "caption",
            "subtitle",
            "字幕",
            "标题",
            "花字",
            "水印",
            "logo",
            "adjustment",
            "调整片段",
            "调节片段",
            "compound",
            "fusion",
            "lower third",
            "lowerthird",
            "name bar",
            "name tag",
            "location bar",
            "info bar",
            "banner",
            "人名条",
            "地名条",
            "姓名条",
            "名字条",
            "地点条",
            "地址条",
            "位置条",
            "信息条",
            "介绍条",
            "角标",
            "台标",
            "标签",
            "标识",
            "贴纸",
            "transition",
            "dissolve",
            "fade",
            "wipe",
            "glitch",
            "转场",
            "叠化",
            "溶解",
            "淡入",
            "淡出",
            "闪白",
            "闪黑",
        ]
        if any(keyword in text for keyword in ignore_keywords):
            return True
        if track_index > 1 and (ext in self._overlay_image_extensions() or self._is_still_image_source(clip_data)):
            return True
        return False

    def _overlay_image_extensions(self):
        return (".png",)

    def _overlay_video_extensions(self):
        return (".mov", ".m4v", ".mp4", ".mxf", ".mkv", ".avi", ".webm")

    def _is_still_image_source(self, clip_data):
        text = self._metadata_text(clip_data)
        return "png" in text

    def _has_alpha_hint(self, clip_data):
        text = self._metadata_text(clip_data)
        if self._has_negative_alpha_hint(text):
            return False
        alpha_keywords = (
            "alpha channel",
            "alpha mode",
            "has alpha",
            "with alpha",
            "straight alpha",
            "transparent",
            "transparency",
            "rgba",
            "argb",
            "bgra",
            "abgr",
            "yuva",
            "premult",
            "4444",
            "prores 4444",
            "prores4444",
            "ap4h",
            "ap4x",
            "animation",
            "qtrle",
            "matte",
            "\u900f\u660e",
            "\u963f\u5c14\u6cd5",
        )
        return any(keyword in text for keyword in alpha_keywords)

    def _has_negative_alpha_hint(self, text):
        return any(keyword in text for keyword in ("alpha mode:none", "alpha:none", "no alpha", "without alpha", "alpha:false", "alpha:0", "\u65e0alpha", "\u6ca1\u6709alpha", "\u4e0d\u542balpha"))

    def _metadata_text(self, clip_data):
        parts = [
            str(clip_data.get("name", "")),
            str(clip_data.get("track_name", "")),
            str(clip_data.get("media_type", "")),
            str(clip_data.get("file_name", "")),
            str(clip_data.get("file_path", "")),
        ]
        for key in ("clip_properties", "item_properties"):
            value = clip_data.get(key)
            if isinstance(value, dict):
                parts.extend("{}:{}".format(k, v) for k, v in value.items())
        return " ".join(parts).lower()

    def _top_visible_main_clips(self):
        normalized = []
        max_end = 0
        for clip_data in self.clips_info:
            if not clip_data or not clip_data.get("enabled", True) or clip_data.get("track_enabled", True) is False:
                continue
            if self._is_overlay_clip(clip_data):
                continue

            start = self._to_int(clip_data.get("start_frame", clip_data.get("start", 0)), 0)
            end = self._to_int(clip_data.get("end_frame", clip_data.get("end", start)), start)
            if end <= start:
                continue

            max_end = max(max_end, end)
            normalized.append({
                "start": start,
                "end": end,
                "track_index": self._to_int(clip_data.get("track_index", 0), 0),
                "signature": self._clip_signature(clip_data),
                "clip_data": clip_data,
            })

        if not normalized:
            return []

        boundaries = {0, max_end}
        for item in normalized:
            boundaries.add(item["start"])
            boundaries.add(item["end"])

        sorted_boundaries = sorted(frame for frame in boundaries if 0 <= frame <= max_end)
        segments = []
        for idx in range(len(sorted_boundaries) - 1):
            start = sorted_boundaries[idx]
            end = sorted_boundaries[idx + 1]
            if end <= start:
                continue

            visible = self._resolve_top_visible_clip(normalized, start, end)
            if not visible:
                continue

            segment = dict(visible["clip_data"])
            segment["start_frame"] = start
            segment["start"] = start
            segment["end_frame"] = end
            segment["end"] = end
            segment["duration"] = end - start
            segment["_signature"] = visible["signature"]
            segment["top_visible"] = True
            segments.append(segment)

        return segments

    def _resolve_top_visible_clip(self, clips, start, end):
        best = None
        for item in clips:
            if item["start"] >= end or item["end"] <= start:
                continue
            if best is None or item["track_index"] > best["track_index"]:
                best = item
                continue
            if item["track_index"] == best["track_index"]:
                item_span = item["end"] - item["start"]
                best_span = best["end"] - best["start"]
                if item_span > best_span or (item_span == best_span and item["start"] > best["start"]):
                    best = item
        return best

    def _clip_signature(self, clip_data):
        return "|".join([
            str(clip_data.get("media_id", "")),
            str(clip_data.get("file_path", "")),
            str(clip_data.get("name", "")),
            str(clip_data.get("source_start_frame", "")),
            str(clip_data.get("source_end_frame", "")),
            str(clip_data.get("track_index", "")),
        ])

    def _to_int(self, value, default=0):
        try:
            return int(float(value))
        except Exception:
            return default

    def _check_grade_status(self, clip):
        status = {
            "node_count": None,
            "has_grade_signal": False,
            "strong_grade_signal": False,
            "metadata_grade_hint": False,
            "reason": "",
        }

        try:
            group = clip.GetColorGroup()
            if group:
                status["has_grade_signal"] = True
                status["strong_grade_signal"] = True
                status["reason"] = "已加入调色组"
        except Exception:
            pass

        try:
            num_nodes = clip.GetNumNodes()
            status["node_count"] = int(num_nodes) if num_nodes is not None else None
            if status["node_count"] and status["node_count"] > 1:
                status["has_grade_signal"] = True
                status["strong_grade_signal"] = True
                status["reason"] = "存在多个调色节点"
            elif status["node_count"] == 1:
                status["metadata_grade_hint"] = True
                status["reason"] = "仅发现单节点，需结合画面判断"
        except Exception:
            pass

        try:
            media_pool_item = clip.GetMediaPoolItem()
            if media_pool_item:
                clip_props = media_pool_item.GetClipProperty()
                lut_used = str(clip_props.get("LUT", "") or "")
                if lut_used and lut_used.lower() not in ("none", "no lut", "无"):
                    status["has_grade_signal"] = True
                    status["strong_grade_signal"] = True
                    status["reason"] = "素材属性包含 LUT"
        except Exception:
            pass

        return status

    def _sample_clip_visual_stats(self, clip_data):
        if not self.frames:
            return None

        start = int(float(clip_data.get("start_frame", clip_data.get("start", 0)) or 0))
        duration = int(float(clip_data.get("duration", 0) or 0))
        if duration <= 0:
            return None

        sample_offsets = self._sample_offsets(start, duration)
        samples = []
        for frame_index in sample_offsets:
            if frame_index < 0 or frame_index >= len(self.frames):
                continue
            stats = self._frame_stats(self.frames[frame_index])
            if stats:
                samples.append(stats)

        if not samples:
            return None

        return {
            "contrast": round(statistics.mean(s["contrast"] for s in samples), 4),
            "saturation": round(statistics.mean(s["saturation"] for s in samples), 4),
            "luma": round(statistics.mean(s["luma"] for s in samples), 4),
        }

    def _sample_offsets(self, start, duration):
        if self.sample_count <= 1:
            return [start + duration // 2]
        ratios = (0.1, 0.25, 0.5, 0.75, 0.9)
        positions = []
        for ratio in ratios:
            frame_offset = min(duration - 1, max(0, int(duration * ratio)))
            frame_index = start + frame_offset
            if frame_index not in positions:
                positions.append(frame_index)
        return positions[:self.sample_count]

    def _frame_stats(self, frame_path):
        try:
            from PIL import Image
            import colorsys
            import numpy as np

            img = Image.open(frame_path).convert("RGB").resize((96, 170), Image.BILINEAR)
            arr = np.asarray(img, dtype=np.float32) / 255.0
            height, width = arr.shape[:2]
            x0 = max(0, int(width * 0.08))
            x1 = min(width, max(x0 + 1, int(width * 0.92)))
            y0 = max(0, int(height * 0.12))
            y1 = min(height, max(y0 + 1, int(height * 0.78)))
            content = arr[y0:y1, x0:x1, :]
            if content.size == 0:
                content = arr
            luma = (
                content[:, :, 0] * 0.2126
                + content[:, :, 1] * 0.7152
                + content[:, :, 2] * 0.0722
            )
            flat_rgb = content.reshape((-1, 3))
            sat_samples = []
            step = max(1, len(flat_rgb) // 1200)
            for r, g, b in flat_rgb[::step]:
                sat_samples.append(colorsys.rgb_to_hsv(float(r), float(g), float(b))[1])

            return {
                "contrast": float(np.percentile(luma, 90) - np.percentile(luma, 10)),
                "saturation": float(statistics.mean(sat_samples)) if sat_samples else 0.0,
                "luma": float(luma.mean()),
            }
        except Exception:
            return None

    def _median_value(self, stats_list, key):
        values = [stats[key] for stats in stats_list if key in stats]
        if not values:
            return None
        return statistics.median(values)

    def _build_verdict(self, grade_status, visual_stats, median_contrast, median_saturation):
        strong_signal = grade_status.get("strong_grade_signal", False)
        has_signal = grade_status.get("has_grade_signal", False)

        if not visual_stats:
            if strong_signal:
                return {"ungraded": False}
            if not has_signal:
                return {
                    "ungraded": True,
                    "confidence": 0.62,
                    "reason": "未发现调色节点、调色组或 LUT",
                }
            return {"ungraded": False}

        contrast = visual_stats["contrast"]
        saturation = visual_stats["saturation"]
        luma = visual_stats.get("luma", 0.5)
        valid_luma = 0.08 < luma < 0.94

        if not has_signal:
            no_grade_abs = valid_luma and (
                (contrast < 0.58 and saturation < 0.56)
                or (contrast < 0.72 and saturation < 0.42)
                or (contrast < 0.44 and saturation < 0.68)
            )
            no_grade_rel = False
            if median_contrast is not None and median_saturation is not None:
                no_grade_rel = (
                    contrast < max(0.32, median_contrast * 0.92)
                    and saturation < max(0.26, median_saturation * 0.92)
                    and valid_luma
                )
            if not (no_grade_abs or no_grade_rel):
                return {"ungraded": False}
            return {
                "ungraded": True,
                "confidence": 0.8,
                "reason": "未发现调色信号，且画面对比/饱和偏低",
            }

        abs_flat = valid_luma and (
            (contrast < (0.28 if strong_signal else 0.58) and saturation < (0.24 if strong_signal else 0.56))
            or (contrast < (0.34 if strong_signal else 0.72) and saturation < (0.22 if strong_signal else 0.42))
            or (contrast < (0.22 if strong_signal else 0.44) and saturation < (0.18 if strong_signal else 0.68))
        )
        rel_flat = False
        if median_contrast is not None and median_saturation is not None:
            rel_flat = (
                contrast < max(0.2 if strong_signal else 0.28, median_contrast * (0.72 if strong_signal else 0.9))
                and saturation < max(0.14 if strong_signal else 0.22, median_saturation * (0.78 if strong_signal else 0.9))
                and valid_luma
            )

        if abs_flat or rel_flat or (not strong_signal and valid_luma):
            confidence = 0.8 if not strong_signal else 0.62
            return {
                "ungraded": True,
                "confidence": confidence,
                "reason": "画面未见强调色信号，疑似未调色",
            }

        if strong_signal:
            return {"ungraded": False}

        if not strong_signal:
            return {"ungraded": False}

        return {"ungraded": False}
