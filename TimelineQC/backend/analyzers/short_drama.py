class ShortDramaTimelineAnalyzer:
    def __init__(self, timeline_info, clips_info, max_micro_clip_frames=3):
        self.timeline_info = timeline_info
        self.clips_info = clips_info
        self.max_micro_clip_frames = max_micro_clip_frames

    def analyze(self):
        results = []
        results.extend(self._check_format())
        results.extend(self._check_micro_clips())
        return results

    def _check_format(self):
        results = []
        width = self._to_int(self.timeline_info.get("width"))
        height = self._to_int(self.timeline_info.get("height"))
        if not width or not height:
            return results

        ratio = width / float(height)
        expected = 9 / 16
        if abs(ratio - expected) > 0.035:
            results.append({
                "type": "format_warning",
                "frame": 0,
                "duration_frames": 1,
                "severity": "warning",
                "note": "短剧工程建议使用 9:16 竖屏，当前分辨率为 {}x{}".format(width, height),
            })
        return results

    def _check_micro_clips(self):
        results = []
        for segment in self._top_visible_main_segments():
            clip_data = segment.get("clip_data", {})
            duration = self._to_int(segment.get("duration"))
            if duration <= 0 or duration > self.max_micro_clip_frames:
                continue

            results.append({
                "type": "flash_frame",
                "frame": segment.get("start", clip_data.get("start_frame", clip_data.get("start", 0))),
                "duration_frames": duration,
                "severity": "warning",
                "clip_name": clip_data.get("name", "Unknown"),
                "track_index": clip_data.get("track_index", 0),
                "detection_mode": "timeline_structure",
                "note": "疑似夹帧/残留超短片段: {} 位于 V{}，仅 {} 帧".format(
                    clip_data.get("name", "Unknown"),
                    clip_data.get("track_index", 0),
                    duration,
                ),
            })

        return results

    def _should_ignore_micro_clip(self, clip_data):
        if not clip_data.get("enabled", True) or clip_data.get("track_enabled", True) is False:
            return True
        return self._is_overlay_clip(clip_data)

    def _top_visible_main_segments(self):
        normalized = []
        max_end = 0
        for clip_data in self.clips_info:
            if self._should_ignore_micro_clip(clip_data):
                continue

            start = self._to_int(clip_data.get("start_frame", clip_data.get("start")), 0)
            end = self._to_int(clip_data.get("end_frame", clip_data.get("end")), start)
            if end is None or end <= start:
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

            if (
                segments
                and segments[-1]["signature"] == visible["signature"]
                and segments[-1]["end"] == start
            ):
                segments[-1]["end"] = end
                segments[-1]["duration"] = end - segments[-1]["start"]
                continue

            segments.append({
                "start": start,
                "end": end,
                "duration": end - start,
                "signature": visible["signature"],
                "clip_data": visible["clip_data"],
            })

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
                best_span = best["end"] - best["start"]
                item_span = item["end"] - item["start"]
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
        ext = __import__("os").path.splitext(str(clip_data.get("file_path") or clip_data.get("file_name") or ""))[1].lower()
        if track_index > 1 and ext == ".png":
            return True
        if ext in self._overlay_video_extensions():
            return False
        overlay_keywords = [
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
        if any(keyword in text for keyword in overlay_keywords):
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

    def _to_int(self, value, default=None):
        if value is None:
            return default
        try:
            return int(float(value))
        except Exception:
            return default
