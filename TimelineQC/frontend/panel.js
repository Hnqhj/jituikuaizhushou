(function () {
    "use strict";

    var TYPE_LABELS = {
        black_frame: "黑帧",
        black_screen: "黑场",
        flash_frame: "夹帧",
        ungraded: "未调色",
        overexposure: "过曝",
        mono_audio: "单声道",
        micro_clip: "夹帧",
        format_warning: "格式",
    };

    var TYPE_CLASS = {
        black_frame: "type-black-frame",
        black_screen: "type-black-screen",
        flash_frame: "type-flash-frame",
        ungraded: "type-ungraded",
        overexposure: "type-overexposure",
        mono_audio: "type-mono-audio",
        micro_clip: "type-flash-frame",
        format_warning: "type-format-warning",
    };

    var TYPE_ORDER = [
        "format_warning",
        "flash_frame",
        "ungraded",
        "black_frame",
        "black_screen",
        "overexposure",
        "mono_audio",
    ];
    var MAX_RENDERED_ISSUES = 800;

    var state = {
        busy: false,
        cancelling: false,
        timelineKey: "",
        currentTimelineIndex: 0,
        timelines: [],
        folders: [],
        selectedFolderId: "__all_timelines",
        syncTimer: null,
        listSyncInFlight: false,
        infoSyncInFlight: false,
        timelineButtonsByIndex: Object.create(null),
        activeTimelineButton: null,
        noticeResolver: null,
        cancelWatchdogTimer: null,
    };

    function $(id) {
        return document.getElementById(id);
    }

    function invoke(action, params) {
        if (window.timelineQC && typeof window.timelineQC.invoke === "function") {
            return window.timelineQC.invoke(action, params || {});
        }

        return new Promise(function (resolve, reject) {
            if (typeof window.ResolveEvent !== "function") {
                reject(new Error("鸡腿快助手 bridge not available"));
                return;
            }
            window.ResolveEvent(action, JSON.stringify(params || {}), function (response) {
                try {
                    resolve(JSON.parse(response));
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    function setText(id, value) {
        var el = $(id);
        if (el) el.textContent = value;
    }

    function setConnection(text, stateName) {
        var el = $("connectionState");
        el.textContent = text;
        el.className = "status-pill " + (stateName || "");
    }

    function showNotice(title, message, kind) {
        var modal = $("noticeModal");
        var dialog = modal ? modal.querySelector(".notice-dialog") : null;
        if (!modal || !dialog) {
            return Promise.resolve();
        }

        if (state.noticeResolver) {
            var previousResolver = state.noticeResolver;
            state.noticeResolver = null;
            previousResolver();
        }

        $("noticeTitle").textContent = title || "提示";
        $("noticeBody").textContent = message || "";
        dialog.className = "notice-dialog" + (kind ? " " + kind : "");
        modal.hidden = false;

        return new Promise(function (resolve) {
            state.noticeResolver = resolve;
        });
    }

    function hideNotice() {
        var modal = $("noticeModal");
        if (modal) {
            modal.hidden = true;
        }
        if (state.noticeResolver) {
            var resolver = state.noticeResolver;
            state.noticeResolver = null;
            resolver();
        }
    }

    function loadTimelineState(options) {
        options = options || {};
        if ((state.busy || state.listSyncInFlight) && !options.force) {
            return Promise.resolve();
        }

        state.listSyncInFlight = true;
        return invoke("get_timeline_list", {
            folder_id: state.selectedFolderId,
            refresh: !!options.refresh,
        })
            .then(function (listResult) {
                if (listResult.error) {
                    throw new Error(listResult.error);
                }
                renderFolderSelect(listResult.folders || [], listResult.selected_folder_id || state.selectedFolderId);
                renderTimelineSelect(listResult.timelines || [], listResult.current_index || 0);
                setText("timelineCount", (listResult.count || 0) + " 条");
                return invoke("get_timeline_info", {});
            })
            .then(function (info) {
                if (info.error) {
                    throw new Error(info.error);
                }
                setConnection("已连接", "ok");
                applyTimelineInfo(info);
                return info;
            })
            .catch(function (error) {
                setConnection("未连接", "error");
                setText("tlName", "错误: " + (error.message || String(error)));
                setText("tlFps", "--");
                setText("tlRes", "--");
                setText("tlTracks", "--");
                setText("tlProfile", "--");
                if (!state.timelines.length) {
                    setText("timelineCount", "--");
                    renderFolderSelect([], state.selectedFolderId);
                    renderTimelineSelect([], 0);
                }
            })
            .finally(function () {
                state.listSyncInFlight = false;
            });
    }

    function renderFolderSelect(folders, selectedFolderId) {
        var select = $("folderSelect");
        if (!select) return;

        var allFolder = { id: "__all_timelines", name: "全部时间线", path: "全部时间线", depth: 0, timeline_count: 0, all: true };
        var sourceFolders = folders && folders.length ? folders : [allFolder];
        state.folders = sourceFolders.filter(function (folder) {
            return folder && (folder.all || (parseInt(folder.timeline_count, 10) || 0) > 0);
        });
        if (!state.folders.some(function (folder) { return folder.all; })) {
            state.folders.unshift(allFolder);
        }

        var exists = state.folders.some(function (folder) {
            return folder.id === selectedFolderId;
        });
        state.selectedFolderId = exists ? selectedFolderId : "__all_timelines";
        select.innerHTML = "";

        state.folders.forEach(function (folder) {
            var option = document.createElement("option");
            var depth = Math.max(0, parseInt(folder.depth, 10) || 0);
            var indent = new Array(depth + 1).join("   ");
            var count = folder.timeline_count === undefined ? 0 : folder.timeline_count;
            option.value = folder.id;
            option.textContent = indent + (folder.name || "未命名文件夹") + " (" + count + ")";
            option.title = folder.path || folder.name || "";
            select.appendChild(option);
        });

        select.value = state.selectedFolderId;
    }

    function loadTimelineInfo(options) {
        options = options || {};
        if ((state.busy || state.infoSyncInFlight) && !options.force) {
            return Promise.resolve();
        }

        state.infoSyncInFlight = true;
        return invoke("get_timeline_info", {})
            .then(function (info) {
                if (info.error) {
                    throw new Error(info.error);
                }
                setConnection("已连接", "ok");
                applyTimelineInfo(info);
                return info;
            })
            .catch(function (error) {
                setConnection("未连接", "error");
                setText("tlName", "错误: " + (error.message || String(error)));
                setText("tlFps", "--");
                setText("tlRes", "--");
                setText("tlTracks", "--");
                setText("tlProfile", "--");
                if (!state.timelines.length) {
                    setText("timelineCount", "--");
                }
            })
            .finally(function () {
                state.infoSyncInFlight = false;
            });
    }

    function renderTimelineSelect(timelines, currentIndex) {
        var list = $("timelineList");
        state.timelines = timelines || [];
        state.currentTimelineIndex = currentIndex || 0;
        state.timelineButtonsByIndex = Object.create(null);
        state.activeTimelineButton = null;
        list.innerHTML = "";

        if (!timelines.length) {
            list.innerHTML = '<div class="timeline-empty">无可用时间线</div>';
            if ($("btnBatchCheck")) $("btnBatchCheck").disabled = true;
            return;
        }

        timelines.forEach(function (item) {
            if (!currentIndex && item.current) {
                currentIndex = item.index;
            }
        });

        state.currentTimelineIndex = currentIndex || 0;
        var fragment = document.createDocumentFragment();
        timelines.forEach(function (item) {
            var button = document.createElement("button");
            var isActive = item.index === state.currentTimelineIndex || (!state.currentTimelineIndex && item.current);
            button.type = "button";
            button.className = "timeline-item" + (isActive ? " active" : "");
            button.dataset.index = String(item.index);
            button.dataset.key = timelineKeyFromItem(item);
            button.disabled = state.busy;
            button.title = item.name || "未命名时间线";
            button.innerHTML =
                '<span class="timeline-index">' + escapeHtml(String(item.index)) + "</span>" +
                '<span class="timeline-main">' +
                '<span class="timeline-name">' + escapeHtml(item.name || "未命名时间线") + "</span>" +
                "</span>";
            fragment.appendChild(button);
            state.timelineButtonsByIndex[item.index] = button;
        });
        list.appendChild(fragment);
        setActiveTimelineIndex(state.currentTimelineIndex, false);
        if ($("btnBatchCheck")) $("btnBatchCheck").disabled = state.busy;
    }

    function applyTimelineInfo(info) {
        var key = timelineKey(info);
        var changed = !!state.timelineKey && state.timelineKey !== key;
        state.timelineKey = key;

        setText("tlName", info.name || "--");
        setText("tlFps", info.frame_rate || "--");
        setText("tlRes", info.resolution || "--");
        setText("tlTracks", String(info.video_track_count || "--"));
        setText("tlProfile", info.profile === "short_drama_vertical" ? "9:16" : "自定义");
        syncTimelineSelectionByKey(key);
        return changed;
    }

    function timelineKey(info) {
        return timelineKeyFromItem(info);
    }

    function timelineKeyFromItem(item) {
        return [
            item && item.unique_id ? item.unique_id : "",
            item && item.name ? item.name : "",
            item && item.start_frame ? item.start_frame : 0,
            item && item.end_frame ? item.end_frame : 0,
            item && item.frame_rate ? item.frame_rate : "",
            item && item.resolution ? item.resolution : "",
            item && item.video_track_count ? item.video_track_count : 0,
        ].join("|");
    }

    function findTimelineIndexByKey(key) {
        var timelines = state.timelines || [];
        for (var i = 0; i < timelines.length; i += 1) {
            if (timelineKeyFromItem(timelines[i]) === key) {
                return timelines[i].index || (i + 1);
            }
        }
        return 0;
    }

    function syncTimelineSelectionByKey(key) {
        if (!state.timelines.length) return;
        var matchedIndex = findTimelineIndexByKey(key);
        if (!matchedIndex || matchedIndex === state.currentTimelineIndex) return;
        setActiveTimelineIndex(matchedIndex, false);
    }

    function setActiveTimelineIndex(index, scrollIntoView) {
        var targetIndex = parseInt(index, 10) || 0;
        state.currentTimelineIndex = targetIndex;
        var previousButton = state.activeTimelineButton;
        var activeButton = (state.timelineButtonsByIndex && state.timelineButtonsByIndex[targetIndex]) || null;
        if (!activeButton) {
            activeButton = document.querySelector('.timeline-item[data-index="' + targetIndex + '"]');
        }

        if (previousButton && previousButton !== activeButton) {
            previousButton.classList.remove("active");
        }
        if (activeButton) {
            activeButton.classList.add("active");
            state.activeTimelineButton = activeButton;
            if (scrollIntoView && typeof activeButton.scrollIntoView === "function") {
                activeButton.scrollIntoView({ block: "nearest" });
            }
        } else {
            state.activeTimelineButton = null;
        }
    }

    function handleTimelineChange(indexValue) {
        var index = parseInt(indexValue, 10);
        if (!index || state.busy) {
            return;
        }

        var previousHint = $("resultHint") ? $("resultHint").textContent : "未运行";
        setBusy(true);
        setText("resultHint", "切换中");
        invoke("select_timeline", { index: index })
            .then(function (result) {
                if (result.error) {
                    showNotice("切换失败", result.error, "error");
                    return loadTimelineState({ force: true });
                }

                if (result.timeline && !result.timeline.error) {
                    setConnection("已连接", "ok");
                    applyTimelineInfo(result.timeline);
                    if (state.timelines.length) {
                        setActiveTimelineIndex(result.selected_index || index, true);
                    } else {
                        loadTimelineState({ force: true, clearOnChange: false });
                    }
                }
            })
            .catch(function (error) {
                showNotice("切换失败", error.message || String(error), "error");
            })
            .finally(function () {
                if ($("resultHint") && $("resultHint").textContent === "切换中") {
                    setText("resultHint", previousHint || "未运行");
                }
                setBusy(false);
            });
    }

    function startBatchCheck() {
        if (state.busy) {
            return;
        }
        if (state.listSyncInFlight) {
            showNotice("请稍后", "时间线列表正在同步，请稍后再批量检查。", "warning");
            return;
        }

        var options = getOptions("quick");
        if (options.check_types.length === 0) {
            showNotice("无法开始", "请至少选择一个检查项。", "warning");
            return;
        }
        options.render_enabled = false;
        options.check_mode = "quick";
        options.add_markers = true;
        var selectedFolder = getSelectedFolderItem();
        var folderCount = selectedFolder && !selectedFolder.all && selectedFolder.timeline_count !== undefined
            ? (parseInt(selectedFolder.timeline_count, 10) || 0)
            : (state.timelines || []).length;
        if (selectedFolder && !selectedFolder.all && !folderCount) {
            showNotice("无法批量检查", "当前文件夹没有可检查的时间线。", "warning");
            return;
        }
        var folderLabel = selectedFolder ? (selectedFolder.path || selectedFolder.name || "当前文件夹") : "当前文件夹";

        setBusy(true);
        setText("resultHint", "批量中");
        $("issuesList").innerHTML = '<div class="empty-state">正在批量检查' + escapeHtml(folderLabel) + "中的时间线。</div>";
        showProgress(5, "准备批量检查");
        var slowTimer = setTimeout(function () {
            showProgress(45, "批量检查进行中");
        }, 600);
        var analyzeTimer = setTimeout(function () {
            showProgress(72, "正在写入标记");
        }, 1800);

        invoke("run_batch_check", {
            folder_id: state.selectedFolderId,
            options: options,
        })
            .then(function (report) {
                clearTimeout(slowTimer);
                clearTimeout(analyzeTimer);
                if (report && report.cancelled) {
                    showProgress(100, "已取消");
                    setText("resultHint", "已取消");
                    $("issuesList").innerHTML = '<div class="empty-state">批量检查已取消。</div>';
                    $("reportInfo").innerHTML = '<div class="muted">已取消。</div>';
                    return;
                }
                if (report && report.error && !(report.issues && report.issues.length)) {
                    showProgress(100, "检查失败");
                    renderReport(report);
                    setText("resultHint", "失败");
                    $("issuesList").innerHTML = '<div class="empty-state error">' + escapeHtml(report.error) + "</div>";
                    return;
                }

                showProgress(100, "完成");
                renderResults(report);
                renderReport(report);
                setText("resultHint", (report.total_issues || 0) + " 个问题");
            })
            .catch(function (error) {
                clearTimeout(slowTimer);
                clearTimeout(analyzeTimer);
                showProgress(100, "执行错误");
                setText("resultHint", "错误");
                $("issuesList").innerHTML = '<div class="empty-state error">' + escapeHtml(error.message || String(error)) + "</div>";
            })
            .finally(function () {
                setBusy(false);
                setTimeout(hideProgress, 900);
                loadTimelineInfo({ clearOnChange: false, force: true });
            });
    }

    function getSelectedFolderItem() {
        var folders = state.folders || [];
        for (var i = 0; i < folders.length; i += 1) {
            if (folders[i].id === state.selectedFolderId) {
                return folders[i];
            }
        }
        return folders.length ? folders[0] : null;
    }

    function selectedCheckTypes() {
        var checkTypes = [];
        if ($("chkShortDrama").checked) checkTypes.push("short_drama_structure");
        if ($("chkBlackFrame").checked) checkTypes.push("black_frame");
        if ($("chkBlackScreen").checked) checkTypes.push("black_screen");
        if ($("chkFlashFrame").checked) checkTypes.push("flash_frame");
        if ($("chkUngraded").checked) checkTypes.push("ungraded");
        if ($("chkOverexposure").checked) checkTypes.push("overexposure");
        if ($("chkMonoAudio").checked) checkTypes.push("mono_audio");
        return checkTypes;
    }

    function getOptions(mode) {
        var checkTypes = selectedCheckTypes();

        return {
            check_mode: mode,
            check_types: checkTypes,
            black_threshold: parseInt($("blackThreshold").value, 10) || 18,
            black_screen_min_frames: parseInt($("blackScreenMinFrames").value, 10) || 8,
            flash_threshold: parseFloat($("flashThreshold").value) || 0.28,
            flash_return_threshold: parseFloat($("flashReturnThreshold").value) || 0.12,
            flash_min_frames: parseInt($("flashMinFrames").value, 10) || 3,
            micro_clip_max_frames: parseInt($("microClipMaxFrames").value, 10) || 3,
            overexposure_luma_threshold: 0.82,
            overexposure_bright_ratio: 0.28,
            overexposure_p95_threshold: 0.97,
            overexposure_min_frames: 3,
            render_height: parseInt($("renderHeight").value, 10) || 960,
            add_markers: $("addMarkers").checked,
            cleanup_frames: $("cleanupFrames").checked,
            render_enabled: mode !== "quick",
        };
    }

    function setBusy(isBusy) {
        state.busy = isBusy;
        if (!isBusy) {
            state.cancelling = false;
            if (state.cancelWatchdogTimer) {
                clearTimeout(state.cancelWatchdogTimer);
                state.cancelWatchdogTimer = null;
            }
        }
        $("btnQuickCheck").disabled = isBusy;
        $("btnBatchCheck").disabled = isBusy || !(state.timelines && state.timelines.length);
        $("btnPreciseCheck").disabled = isBusy;
        $("btnClearMarkers").disabled = isBusy;
        $("btnRefreshTimeline").disabled = isBusy;
        if ($("btnCancelCheck")) {
            $("btnCancelCheck").hidden = !isBusy;
            $("btnCancelCheck").disabled = !isBusy || state.cancelling;
            $("btnCancelCheck").textContent = state.cancelling ? "取消中" : "取消检查";
        }
        if ($("folderSelect")) $("folderSelect").disabled = isBusy;
        Array.prototype.forEach.call(document.querySelectorAll(".timeline-item"), function (button) {
            button.disabled = isBusy;
        });
    }

    function showProgress(percent, text) {
        $("progressSection").hidden = false;
        $("progressBar").style.width = percent + "%";
        $("progressText").textContent = text;
    }

    function hideProgress() {
        $("progressSection").hidden = true;
        $("progressText").textContent = "";
    }

    function cancelCheck() {
        if (!state.busy || state.cancelling) {
            return;
        }

        state.cancelling = true;
        setText("resultHint", "取消中");
        showProgress(100, "正在取消检查");
        setBusy(true);

        if (state.cancelWatchdogTimer) {
            clearTimeout(state.cancelWatchdogTimer);
        }
        state.cancelWatchdogTimer = setTimeout(function () {
            if (state.busy && state.cancelling) {
                showProgress(100, "");
                setText("resultHint", "");
            }
        }, 2500);

        invoke("cancel_check", {})
            .then(function (result) {
                if (result && result.active === false) {
                    setBusy(false);
                    hideProgress();
                }
            })
            .catch(function () {
                // ignore transport errors while canceling
            });
    }

    function startCheck(mode) {
        var options = getOptions(mode);
        if (options.check_types.length === 0) {
            showNotice("无法开始", "请至少选择一个检查项。", "warning");
            return;
        }

        setBusy(true);
        setText("resultHint", "运行中");
        $("issuesList").innerHTML = '<div class="empty-state">正在检查时间线。</div>';
        showProgress(12, "读取时间线");

        var slowTimer = null;
        var analyzeTimer = null;
        if (mode === "quick") {
            slowTimer = setTimeout(function () {
                showProgress(45, "抽样时间线画面");
            }, 400);
            analyzeTimer = setTimeout(function () {
                showProgress(72, "分析画面与轨道信息");
            }, 1200);
        } else {
            slowTimer = setTimeout(function () {
                showProgress(45, "生成临时检查帧");
            }, 900);
            analyzeTimer = setTimeout(function () {
                showProgress(72, "分析画面数据");
            }, 2500);
        }

        invoke("run_check", options)
            .then(function (report) {
                clearTimeout(slowTimer);
                clearTimeout(analyzeTimer);

                if (report && report.cancelled) {
                    showProgress(100, "已取消");
                    setText("resultHint", "已取消");
                    $("issuesList").innerHTML = '<div class="empty-state">检查已取消。</div>';
                    $("reportInfo").innerHTML = '<div class="muted">已取消。</div>';
                    return;
                }

                if (report.error && !(report.issues && report.issues.length)) {
                    showProgress(100, "检查失败");
                    renderReport(report);
                    setText("resultHint", "失败");
                    $("issuesList").innerHTML = '<div class="empty-state error">' + escapeHtml(report.error) + "</div>";
                    return;
                }

                showProgress(100, "完成");
                renderResults(report);
                renderReport(report);
            })
            .catch(function (error) {
                clearTimeout(slowTimer);
                clearTimeout(analyzeTimer);
                showProgress(100, "执行错误");
                setText("resultHint", "错误");
                $("issuesList").innerHTML = '<div class="empty-state error">' + escapeHtml(error.message || String(error)) + "</div>";
            })
            .finally(function () {
                setBusy(false);
                setTimeout(hideProgress, 900);
                loadTimelineInfo({ clearOnChange: false });
            });
    }

    function renderResults(report) {
        var issues = report.issues || [];
        var displayIssues = issues.slice(0, MAX_RENDERED_ISSUES);
        var counts = report.batch ? canonicalCounts(report.issues_by_type || {}) : (issues.length ? countIssuesByType(issues) : canonicalCounts(report.issues_by_type || {}));
        var total = report.batch ? (report.total_issues || 0) : (issues.length || report.total_issues || 0);
        var skipped = report.skipped_checks || [];
        var quickVisual = report.quick_visual || {};
        var preflight = quickVisual.preflight || {};

        if (report.batch) {
            setText("resultHint", total + " 个问题 / " + (report.checked_timelines || 0) + " 条");
        } else {
            setText("resultHint", total + " 个问题");
        }
        renderSummary(total, counts);

        if (!issues.length) {
            var message = report.batch ? "批量检查完成，未发现问题。" : "未发现问题。";
            if (report.batch && report.failed_timelines) {
                message += " " + report.failed_timelines + " 条时间线检查失败，详情见状态。";
            }
            if (skipped.length) {
                message += " 当前模式未执行 " + skipped.map(labelForType).join("、") + " 画面检查。";
            }
            if (preflight.suspect_interval_count) {
                message += " 堆叠预判命中 " + preflight.suspect_interval_count + " 个疑似区间。";
            }
            if (quickVisual && quickVisual.error) {
                message += " 快速抽帧失败: " + quickVisual.error;
            }
            $("issuesList").innerHTML = '<div class="empty-state">' + escapeHtml(message) + "</div>";
            return;
        }

        var html = "";
        displayIssues.forEach(function (issue) {
            var type = canonicalIssueType(issue.type || "unknown");
            var klass = TYPE_CLASS[type] || "info";
            var label = TYPE_LABELS[type] || type;
            var frame = issue.frame === undefined ? "--" : issue.frame;
            var duration = issue.duration_frames || issue.duration || 1;
            var note = issue.note || "";

            html += '<div class="issue-row ' + klass + '">';
            html += '<div class="issue-type">' + escapeHtml(label) + "</div>";
            html += '<div class="issue-body">';
            html += '<div class="issue-note">' + escapeHtml(note) + "</div>";
            html += '<div class="issue-sub">帧 ' + escapeHtml(String(frame)) + " · " + escapeHtml(String(duration)) + " 帧</div>";
            html += "</div>";
            html += "</div>";
        });
        if (issues.length > displayIssues.length) {
            html += '<div class="issue-row info issue-row-more"><div class="issue-type">更多</div><div class="issue-body"><div class="issue-note">仅显示前 ' + escapeHtml(String(displayIssues.length)) + ' 条，共 ' + escapeHtml(String(issues.length)) + ' 条。</div><div class="issue-sub">完整结果见报告与时间线标记。</div></div></div>';
        }
        $("issuesList").innerHTML = html;
    }

    function renderSummary(total, counts) {
        counts = canonicalCounts(counts || {});
        var html = '<div class="summary-cell total"><span>' + total + '</span><label>总数</label></div>';
        TYPE_ORDER.forEach(function (type) {
            var count = counts[type] || 0;
            html += '<div class="summary-cell ' + (TYPE_CLASS[type] || "info") + '"><span>' + count + "</span><label>" + TYPE_LABELS[type] + "</label></div>";
        });
        $("summaryCards").innerHTML = html;
    }

    function renderReport(report) {
        if (report && report.batch) {
            renderBatchReport(report);
            return;
        }

        var render = report.render || {};
        var renderError = report.render_error || render.error || "";
        var markerError = report.marker_error || "";
        var markerCount = report.marker_count === undefined ? "--" : report.marker_count;
        var options = report.options || {};
        var quickVisual = report.quick_visual || {};
        var preflight = quickVisual.preflight || render.quick_visual_preflight || {};
        var modeLabel = options.check_mode === "quick" ? "快速检查（内部抽帧）" : "精确检查（临时帧）";
        var rows = [];

        rows.push(["检查模式", modeLabel]);
        rows.push(["检查时间", report.check_time || "--"]);
        rows.push(["Marker", markerError ? "写入失败: " + markerError : "写入 " + markerCount + " 个"]);
        if (render.skipped) {
            rows.push(["渲染", "已跳过视频导出"]);
        } else {
            rows.push(["渲染", renderError ? "失败: " + renderError : (render.rendered_file ? "完成" : "未执行/无输出")]);
        }
        if (render.sample_count || quickVisual.sample_count) {
            rows.push(["快速抽帧", (render.sample_count || quickVisual.sample_count || 0) + "/" + (render.requested_sample_count || quickVisual.requested_sample_count || 0) + " 帧"]);
        }
        if (render.source_counts || quickVisual.source_counts) {
            var sources = render.source_counts || quickVisual.source_counts || {};
            var sourceText = Object.keys(sources).map(function (key) {
                return key + ":" + sources[key];
            }).join(" / ");
            if (sourceText) rows.push(["取帧来源", sourceText]);
        }
        if (preflight && preflight.mode) {
            rows.push(["堆叠预判", "疑似区间 " + (preflight.suspect_interval_count || 0) + " 个 / 分段 " + (preflight.segment_count || 0) + " 个"]);
            if (preflight.counters) {
                rows.push(["预判来源", "黑源:" + (preflight.counters.black_source || 0) + " 短片段:" + (preflight.counters.short_visible || 0) + " 转场:" + (preflight.counters.transition_window_sampled || preflight.counters.transition_window || 0) + "/" + (preflight.counters.transition_window || 0)]);
            }
        }
        if (report.transition_protection && report.transition_protection.protected_interval_count !== undefined) {
            rows.push(["转场保护", (report.transition_protection.protected_interval_count || 0) + " 个区间 / " + (report.transition_protection.candidate_count || 0) + " 个候选"]);
        }
        if (quickVisual.plan && quickVisual.plan.strategy) {
            rows.push(["抽样策略", quickVisual.plan.strategy]);
        } else if (render.quick_visual_plan && render.quick_visual_plan.strategy) {
            rows.push(["抽样策略", render.quick_visual_plan.strategy]);
        }
        if (quickVisual.error) {
            rows.push(["抽帧状态", "失败: " + quickVisual.error]);
        }
        if (quickVisual.errors && quickVisual.errors.length) {
            rows.push(["抽帧错误", quickVisual.errors.length + " 个"]);
        }
        if (render.settings_mode) rows.push(["渲染模式", render.settings_mode]);
        if (render.attempts && render.attempts.length) {
            rows.push(["设置尝试", render.attempts.map(function (item) {
                return item.mode + ":" + (item.ok ? "ok" : "fail");
            }).join(" / ")]);
        }
        if (report.skipped_checks && report.skipped_checks.length) {
            rows.push(["跳过检查", report.skipped_checks.map(labelForType).join("、")]);
        }
        if (report.report_file) rows.push(["报告", report.report_file]);
        if (report.error) rows.push(["错误", report.error]);

        var html = "";
        rows.forEach(function (row) {
            html += '<div class="report-row"><span>' + escapeHtml(row[0]) + "</span><strong>" + escapeHtml(String(row[1])) + "</strong></div>";
        });
        $("reportInfo").innerHTML = html;
    }

    function renderBatchReport(report) {
        var rows = [];
        rows.push(["检查模式", "批量快速检查"]);
        rows.push(["文件夹", report.folder_path || report.folder_name || "全部时间线"]);
        rows.push(["检查时间", report.check_time || "--"]);
        rows.push(["时间线", (report.success_timelines || 0) + "/" + (report.total_timelines || 0) + " 完成"]);
        rows.push(["失败", report.failed_timelines || 0]);
        rows.push(["Marker", "写入 " + (report.marker_count || 0) + " 个"]);
        rows.push(["问题", (report.total_issues || 0) + " 个"]);

        var failed = (report.timeline_reports || []).filter(function (item) {
            return item.error;
        });
        if (failed.length) {
            rows.push(["失败详情", failed.slice(0, 4).map(function (item) {
                return (item.name || "未命名时间线") + ": " + item.error;
            }).join(" / ")]);
        }

        var html = "";
        rows.forEach(function (row) {
            html += '<div class="report-row"><span>' + escapeHtml(row[0]) + "</span><strong>" + escapeHtml(String(row[1])) + "</strong></div>";
        });
        $("reportInfo").innerHTML = html;
    }

    function clearMarkers() {
        setBusy(true);
        invoke("clear_markers", {})
            .then(function (result) {
                if (result.error) {
                    showNotice("清除标记失败", result.error, "error");
                } else {
                    var cleared = result.cleared || 0;
                    var remaining = result.remaining || 0;
                    resetAnalysisView("鸡腿快助手标记已清除，检查结果已同步清空。", "已清除");
                    if (remaining > 0) {
                        showNotice("清除完成", "已清除 " + cleared + " 个标记。\n仍有 " + remaining + " 个标记未删除。", "warning");
                    } else {
                        showNotice("清除完成", "已清除 " + cleared + " 个鸡腿快助手标记。\n检查结果已清空。", "");
                    }
                    loadTimelineInfo({ clearOnChange: false, force: true });
                }
            })
            .catch(function (error) {
                showNotice("操作失败", error.message || String(error), "error");
            })
            .finally(function () {
                setBusy(false);
            });
    }

    function resetAnalysisView(message, hint) {
        renderSummary(0, {});
        setText("resultHint", hint || "未运行");
        $("issuesList").innerHTML = '<div class="empty-state">' + escapeHtml(message || "等待检查。") + "</div>";
        $("reportInfo").innerHTML = '<div class="muted">暂无报告。</div>';
    }

    function labelForType(type) {
        return TYPE_LABELS[canonicalIssueType(type)] || type;
    }

    function canonicalIssueType(type) {
        return type === "micro_clip" ? "flash_frame" : type;
    }

    function canonicalCounts(counts) {
        var result = {};
        Object.keys(counts || {}).forEach(function (type) {
            var canonical = canonicalIssueType(type);
            result[canonical] = (result[canonical] || 0) + (counts[type] || 0);
        });
        return result;
    }

    function countIssuesByType(issues) {
        var result = {};
        (issues || []).forEach(function (issue) {
            var type = canonicalIssueType(issue && issue.type ? issue.type : "unknown");
            result[type] = (result[type] || 0) + 1;
        });
        return result;
    }

    function escapeHtml(text) {
        var div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    function initAdvanced() {
        $("toggleAdvanced").addEventListener("click", function () {
            var body = $("advBody");
            var arrow = $("advArrow");
            body.hidden = !body.hidden;
            arrow.textContent = body.hidden ? "展开" : "收起";
        });
        $("flashThreshold").addEventListener("input", function () {
            $("flashThresholdVal").textContent = this.value;
        });
        $("flashReturnThreshold").addEventListener("input", function () {
            $("flashReturnThresholdVal").textContent = this.value;
        });
    }

    function initTimelineSync() {
        $("timelineList").addEventListener("click", function (event) {
            var button = event.target.closest(".timeline-item");
            if (!button) return;
            handleTimelineChange(button.dataset.index);
        });
        $("btnRefreshTimeline").addEventListener("click", function () {
            loadTimelineState({ force: true, refresh: true, clearOnChange: true });
        });
        $("folderSelect").addEventListener("change", function () {
            state.selectedFolderId = this.value || "__all_timelines";
            state.timelines = [];
            state.timelineButtonsByIndex = Object.create(null);
            state.activeTimelineButton = null;
            renderTimelineSelect([], 0);
            setText("timelineCount", "--");
            loadTimelineState({ force: true, clearOnChange: false });
        });
        state.syncTimer = setInterval(function () {
            if (document.hidden) return;
            loadTimelineInfo({ clearOnChange: true });
        }, 10000);
        document.addEventListener("visibilitychange", function () {
            if (!document.hidden) {
                loadTimelineInfo({ clearOnChange: true });
            }
        });
        window.addEventListener("beforeunload", function () {
            clearInterval(state.syncTimer);
        });
    }

    function initWindowControls() {
        var controls = {
            btnMinimize: "window_minimize",
            btnMaximize: "window_toggle_maximize",
            btnClose: "window_close",
        };

        Object.keys(controls).forEach(function (id) {
            var button = $(id);
            if (!button) return;
            button.addEventListener("click", function () {
                invoke(controls[id], {}).catch(function () {});
            });
        });
    }

    function initNoticeModal() {
        var modal = $("noticeModal");
        var okButton = $("noticeOk");
        if (okButton) {
            okButton.addEventListener("click", hideNotice);
        }
        if (modal) {
            modal.addEventListener("click", function (event) {
                if (event.target === modal) {
                    hideNotice();
                }
            });
        }
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && modal && !modal.hidden) {
                hideNotice();
            }
        });
    }

    function init() {
        resetAnalysisView("等待检查。", "未运行");
        initAdvanced();
        initTimelineSync();
        initWindowControls();
        initNoticeModal();
        $("btnQuickCheck").addEventListener("click", function () {
            startCheck("quick");
        });
        $("btnBatchCheck").addEventListener("click", startBatchCheck);
        $("btnPreciseCheck").addEventListener("click", function () {
            startCheck("precise");
        });
        $("btnClearMarkers").addEventListener("click", clearMarkers);
        $("btnCancelCheck").addEventListener("click", cancelCheck);
        loadTimelineState({ force: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();

