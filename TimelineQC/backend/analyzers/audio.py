import re


class MonoAudioAnalyzer:
    def __init__(self, audio_clips_info):
        self.audio_clips_info = audio_clips_info or []

    def analyze(self):
        results = []
        for clip_data in self.audio_clips_info:
            if not clip_data or clip_data.get("enabled", True) is False or clip_data.get("track_enabled", True) is False:
                continue

            evidence = self._get_mono_audio_evidence(clip_data)
            if not evidence or not evidence.get("mono"):
                continue

            start_frame = self._to_int(clip_data.get("start_frame", clip_data.get("start", 0)), 0)
            end_frame = self._to_int(clip_data.get("end_frame", clip_data.get("end", start_frame + 1)), start_frame + 1)
            duration = self._to_int(clip_data.get("duration", max(1, end_frame - start_frame)), max(1, end_frame - start_frame))
            duration = max(1, duration)
            clip_name = clip_data.get("name", "Unknown")
            track_index = self._to_int(clip_data.get("track_index", 0), 0)
            track_label = "A{}".format(track_index) if track_index else "A?"

            results.append(
                {
                    "type": "mono_audio",
                    "frame": start_frame,
                    "duration_frames": duration,
                    "severity": "warning",
                    "confidence": evidence.get("confidence", 0.75),
                    "clip_name": clip_name,
                    "track_index": track_index,
                    "note": "音频疑似单声道: {} ({})，依据 {}".format(
                        clip_name,
                        track_label,
                        evidence.get("label", "音频属性"),
                    ),
                    "detection_mode": "timeline_audio",
                }
            )

        return results

    def _get_mono_audio_evidence(self, clip_data):
        candidates = []
        clip_props = self._as_dict(clip_data.get("clip_properties"))
        item_props = self._as_dict(clip_data.get("item_properties"))

        for key in clip_props:
            candidates.append({"key": key, "value": clip_props[key], "priority": 3})
        for key in item_props:
            candidates.append({"key": key, "value": item_props[key], "priority": 2})
        candidates.append({"key": "track_format", "value": clip_data.get("track_format", ""), "priority": 2})
        candidates.append({"key": "track_type", "value": clip_data.get("track_type", ""), "priority": 2})
        candidates.append({"key": "track_name", "value": clip_data.get("track_name", ""), "priority": 1})

        best_mono = None
        explicit_stereo = False

        for candidate in candidates:
            parsed = self._parse_audio_channel_evidence(candidate["key"], candidate["value"], candidate["priority"])
            if not parsed:
                continue
            if parsed.get("mono"):
                if not best_mono or parsed.get("confidence", 0.0) > best_mono.get("confidence", 0.0):
                    best_mono = parsed
            elif parsed.get("explicit_channels") and parsed.get("channel_count", 0) > 1 and candidate["priority"] >= 2:
                explicit_stereo = True

        if not best_mono:
            return None
        if explicit_stereo and best_mono.get("confidence", 0.0) < 0.9:
            return None
        return best_mono

    def _parse_audio_channel_evidence(self, key, value, priority):
        if value is None or value == "":
            return None

        key_text = str(key or "").lower()
        raw_text = str(value).strip()
        text = raw_text.lower()
        channel_key = bool(re.search(r"channel|channels|声道|聲道|track_format|track_type", key_text))
        count_match = re.search(r"(?:^|[^0-9])([1-9][0-9]?)\s*(?:ch|chs|channel|channels|声道|聲道)(?:[^0-9]|$)", text)
        key_count_match = re.search(r"^\s*([1-9][0-9]?)(?:\.0+)?\s*$", text) if channel_key else None
        labeled_count_match = re.search(r"(?:channels?|声道|聲道)\D{0,8}([1-9][0-9]?)", text)

        if re.search(r"\bmono\b|单声道|單聲道", text):
            return {
                "mono": True,
                "label": "{}: {}".format(key, raw_text),
                "confidence": 0.92 if priority >= 2 else 0.78,
                "explicit_channels": True,
                "channel_count": 1,
            }

        matched_count = count_match or key_count_match or labeled_count_match
        if matched_count and (channel_key or count_match or labeled_count_match):
            channel_count = self._to_int(matched_count.group(1), 0)
            if channel_count == 1:
                return {
                    "mono": True,
                    "label": "{}: {}".format(key, raw_text),
                    "confidence": 0.9 if priority >= 2 else 0.72,
                    "explicit_channels": True,
                    "channel_count": 1,
                }
            if channel_count > 1:
                return {
                    "mono": False,
                    "label": "{}: {}".format(key, raw_text),
                    "confidence": 0.82,
                    "explicit_channels": True,
                    "channel_count": channel_count,
                }

        if re.search(r"\bstereo\b|立体声|立體聲", text):
            return {
                "mono": False,
                "label": "{}: {}".format(key, raw_text),
                "confidence": 0.82,
                "explicit_channels": True,
                "channel_count": 2,
            }

        return None

    def _as_dict(self, value):
        return value if isinstance(value, dict) else {}

    def _to_int(self, value, default=0):
        try:
            return int(float(value))
        except Exception:
            return default
