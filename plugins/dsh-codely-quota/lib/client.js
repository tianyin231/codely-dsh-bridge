/**
 * @dsh-external/dsh-codely-quota — client 悬浮「额度圈」（桌宠式）。
 *
 * 形态：右下角悬浮小圆环（类似 dsh 的上下文占用指示圈）：
 *   · 圆环 = 每日赠送额度【剩余比例】（>25% 绿 / 10-25% 琥珀 / <10% 红），中心显示百分比；
 *   · 单击 → 展开详情浮层（每日赠送/充值余额/套餐窗口/月度统计/速率限制），再次单击或点外部关闭；
 *   · 按住可拖拽换位置（localStorage 记忆）；
 *   · 代理没开就不启用：轮询 /api/health，proxyUp=false 时整体隐藏，恢复后自动出现；
 *   · 🎨 主题自适应：跟随 dsh 全局主题（body[data-ds-dark-theme]），浅色白底黑字 / 深色深底浅字，
 *     通过 MutationObserver 监听主题属性实时切换（自定义属性 --cqw-* 驱动全部样式）。
 * 数据流：fetch 插件 host API（/@dsh-external/dsh-codely-quota/api）→ host → 本地代理 /quota → Codely 官网。
 * 手写 CJS + __ModuleLoader__ banner（等价 tsdown 产物，无外部依赖）。
 */
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-codely-quota",
  factory: () => {
    var module = { exports: {} };

    var API = "/@dsh-external/dsh-codely-quota/api";
    var POS_KEY = "dsh-codely-quota.pos.v1";
    var THEME_ATTR = "data-ds-dark-theme";

    /* ═══ 主题调色板 ═══
     * 全部配色收敛到 wrapper 上的 --cqw-* 自定义属性；切主题只换这几个值，DOM 内样式引用 var(--cqw-*) 自动跟随。 */
    var THEME = {
      light: {
        "--cqw-surface": "#ffffff",     // 面板/浮层底色
        "--cqw-fg": "#16161c",          // 正文（黑字）
        "--cqw-muted": "#72727c",       // 次要文字
        "--cqw-card": "#f7f7fb",        // 分区卡片底
        "--cqw-cardBorder": "#e7e7ee",  // 卡片描边
        "--cqw-panelBorder": "#e2e2e9", // 面板描边
        "--cqw-track": "#e9e9ee",       // 进度条轨道
        "--cqw-btn": "#f3f3f7",         // 按钮底
        "--cqw-btnBorder": "#d9d9e2",   // 按钮描边
        "--cqw-ball": "#ffffff",        // 圆环球底
        "--cqw-ballBorder": "#e4e4ec",  // 圆环球描边
        "--cqw-ringTrack": "#e3e3ec",   // 圆环底轨
        "--cqw-bannerBg": "#fdecec",    // 错误条底
        "--cqw-bannerBorder": "#f0b6b9",
        "--cqw-bannerFg": "#c62828",
        "--cqw-shadow": "rgba(0,0,0,.18)",
        "--cqw-tagNeutral": "#6b6b75",  // 「免费版」灰标
      },
      dark: {
        "--cqw-surface": "#1d1d24",
        "--cqw-fg": "#e9e9ee",
        "--cqw-muted": "#9a9aa5",
        "--cqw-card": "#23232b",
        "--cqw-cardBorder": "#2f2f39",
        "--cqw-panelBorder": "#33333d",
        "--cqw-track": "#2b2b34",
        "--cqw-btn": "#2c2c35",
        "--cqw-btnBorder": "#3d3d48",
        "--cqw-ball": "#23232b",
        "--cqw-ballBorder": "#3a3a44",
        "--cqw-ringTrack": "#3a3a44",
        "--cqw-bannerBg": "#3a2326",
        "--cqw-bannerBorder": "#6e3b40",
        "--cqw-bannerFg": "#ffb3b6",
        "--cqw-shadow": "rgba(0,0,0,.55)",
        "--cqw-tagNeutral": "#9d9da8",
      },
    };

    function isDarkTheme() {
      return !!document.body && document.body.hasAttribute(THEME_ATTR);
    }

    /** 把当前主题 token 写到 wrapper（所有子元素引用 var(--cqw-*) 会实时跟随） */
    function applyThemeVars(w) {
      var dark = isDarkTheme();
      var map = dark ? THEME.dark : THEME.light;
      for (var k in map) {
        if (Object.prototype.hasOwnProperty.call(map, k)) w.style.setProperty(k, map[k]);
      }
    }

    /* ── 小工具 ── */
    function fmt(v) {
      return v == null ? "-" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
    }
    function pt(v) {
      return String(v == null ? "" : v).slice(0, 19).replace("T", " ");
    }
    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }
    function usedPct(used, quota) {
      var total = Number(quota);
      return total > 0 ? Math.min(100, Math.max(0, (Number(used) / total) * 100)) : 0;
    }
    function bar(p) {
      var w = Math.round(p);
      return '<div style="height:5px;border-radius:3px;background:var(--cqw-track);overflow:hidden"><div style="height:100%;width:' + w + '%;background:var(--dsw-accent-color,#4f8cff);border-radius:3px;transition:width .3s"></div></div>';
    }
    function tag(text, color) {
      return '<span style="display:inline-block;padding:0 6px;border-radius:5px;font-size:10px;line-height:17px;color:' + color + ';background:color-mix(in srgb,' + color + ' 14%,transparent);border:1px solid color-mix(in srgb,' + color + ' 34%,transparent)">' + text + "</span>";
    }

    var WIN_LABEL = {
      usage_5h: "5小时用量窗",
      subscription_week: "订阅周窗口",
      subscription_month: "订阅月窗口",
    };

    /* ── 实例生命周期（热重载只保留最新一个） ── */
    var activeDispose = null;

    function buildPet() {
      /* 外壳：fixed 定位 */
      var wrapper = document.createElement("div");
      wrapper.style.cssText =
        "position:fixed;z-index:2147483000;display:none;font-family:var(--dsw-font-ui,sans-serif);filter:drop-shadow(0 4px 14px var(--cqw-shadow))";
      applyThemeVars(wrapper);

      var pos = null;
      try { pos = JSON.parse(localStorage.getItem(POS_KEY) || "null"); } catch (e) { pos = null; }
      if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
        wrapper.style.left = pos.left + "px";
        wrapper.style.top = pos.top + "px";
      } else {
        wrapper.style.right = "18px";
        wrapper.style.bottom = "86px";
      }

      /* 圆环按钮（无 title：悬停不弹原生气泡，点击才展开） */
      var pet = document.createElement("div");
      pet.style.cssText =
        "width:38px;height:38px;cursor:pointer;border-radius:50%;background:var(--cqw-ball);border:1px solid var(--cqw-ballBorder);display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;-webkit-user-select:none";
      var R = 14;
      var CIRC = 2 * Math.PI * R;
      pet.innerHTML =
        '<svg width="36" height="36" viewBox="0 0 36 36" style="display:block">' +
          '<circle cx="18" cy="18" r="' + R + '" fill="none" stroke="var(--cqw-ringTrack)" stroke-width="3.5"/>' +
          '<circle data-cq="ring" cx="18" cy="18" r="' + R + '" fill="none" stroke="#4f8cff" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="' + CIRC + '" stroke-dashoffset="' + CIRC + '" transform="rotate(-90 18 18)" style="transition:stroke-dashoffset .4s, stroke .3s"/>' +
          '<text data-cq="pct" x="18" y="18" text-anchor="middle" dominant-baseline="central" style="font-size:9px;font-weight:700;fill:var(--cqw-fg)">?</text>' +
        "</svg>";
      wrapper.appendChild(pet);

      /* 展开浮层 */
      var panel = document.createElement("div");
      panel.style.cssText =
        "display:none;position:absolute;right:0;bottom:calc(100% + 10px);width:344px;max-width:calc(100vw - 40px);max-height:min(70vh,560px);overflow:auto;border:1px solid var(--cqw-panelBorder);border-radius:12px;background:var(--cqw-surface);box-shadow:0 10px 40px var(--cqw-shadow);padding:12px 14px;font-size:12px;line-height:18px;color:var(--cqw-fg)";
      panel.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-weight:700;font-size:13px">Codely 积分额度</span>' +
          '<span data-cq="plan"></span>' +
          '<span style="flex:1"></span>' +
          '<span data-cq="age" style="font-size:10px;color:var(--cqw-muted)"></span>' +
          '<button data-cq="refresh" style="background:var(--cqw-btn);color:var(--cqw-fg);border:1px solid var(--cqw-btnBorder);border-radius:6px;padding:1px 8px;font-size:11px;cursor:pointer">刷新</button>' +
        "</div>" +
        '<div data-cq="banner" style="display:none;margin-top:8px;border:1px solid var(--cqw-bannerBorder);background:var(--cqw-bannerBg);border-radius:8px;padding:6px 8px;font-size:11px;color:var(--cqw-bannerFg)"></div>' +
        '<div data-cq="body" style="display:grid;gap:8px;margin-top:10px"></div>' +
        '<div data-cq="foot" style="margin-top:10px;font-size:10px;color:var(--cqw-muted)"></div>';
      wrapper.appendChild(panel);
      document.body.appendChild(wrapper);

      /* ── 状态 ── */
      var data = null;
      var lastOk = 0;
      var lastErr = "";
      var proxyOk = false;
      var refreshMs = 30000;
      var healthMs = 15000;
      var visible = false;
      var panelOpen = false;
      var disposed = false;
      var timers = [];

      var ring = wrapper.querySelector('[data-cq="ring"]');
      var pctEl = wrapper.querySelector('[data-cq="pct"]');
      var planEl = wrapper.querySelector('[data-cq="plan"]');
      var ageEl = wrapper.querySelector('[data-cq="age"]');
      var bannerEl = wrapper.querySelector('[data-cq="banner"]');
      var bodyEl = wrapper.querySelector('[data-cq="body"]');
      var footEl = wrapper.querySelector('[data-cq="foot"]');
      var refreshBtn = wrapper.querySelector('[data-cq="refresh"]');

      /* ── 圆环 ── */
      function setRing(p, color, label) {
        var off = CIRC - (CIRC * Math.max(0, Math.min(100, p))) / 100;
        ring.setAttribute("stroke-dashoffset", String(off));
        ring.setAttribute("stroke", color);
        pctEl.textContent = label;
      }
      function ringState() {
        if (!proxyOk) { setRing(0, "#6b6b76", "!"); return; }
        if (!data) {
          if (lastErr) { setRing(0, "#e5484d", "!"); return; }
          setRing(14, "#8b8b96", "…");
          return;
        }
        var da = data.dailyAllowance;
        if (da && Number(da.quota_points) > 0) {
          var remain = 100 - usedPct(da.used_points, da.quota_points);
          var color = remain > 25 ? "#36b37e" : remain > 10 ? "#d99a1c" : "#e5484d";
          setRing(remain, color, Math.round(remain) + "%");
          return;
        }
        var eff = data.billing ? Number(data.billing.effective_available_points) : 0;
        setRing(eff > 0 ? 100 : 0, "#4f8cff", eff > 0 ? "有" : "0");
      }

      /* ── 面板内容 ── */
      function renderBody() {
        if (!data) {
          bodyEl.innerHTML = lastErr
            ? '<div style="color:var(--cqw-bannerFg);font-size:11px">' + esc(lastErr) + "</div>"
            : '<div style="color:var(--cqw-muted)">加载中…</div>';
          return;
        }
        var plan = data.plan, da = data.dailyAllowance, bill = data.billing, cp = data.codingPlan, t = data.totals, g = data.giftCredits;
        var ch = [];
        planEl.innerHTML = plan && plan.plan_type !== "free"
          ? tag("套餐·" + ((plan.plan_tag || plan.plan_type) + "").toUpperCase(), "#4f8cff")
          : tag("免费版", "var(--cqw-tagNeutral, #6b6b75)");

        if (da && Number(da.quota_points) > 0) {
          ch.push(
            '<div style="border:1px solid var(--cqw-cardBorder);border-radius:10px;padding:8px 10px;background:var(--cqw-card)">' +
              '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--cqw-muted)"><span>每日赠送' + (da.quota_timezone ? "（" + da.quota_timezone + "）" : "") + '</span><span data-cq="countdown"></span></div>' +
              '<div style="display:flex;align-items:baseline;gap:6px;margin:4px 0 6px"><span style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums">' + fmt(da.remaining_points) + '</span><span style="color:var(--cqw-muted);font-size:11px">/ 每日 ' + fmt(da.quota_points) + " 积分</span></div>" +
              bar(usedPct(da.used_points, da.quota_points)) +
              '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--cqw-muted);margin-top:2px"><span>已用 ' + fmt(da.used_points) + "</span><span>窗口 " + pt(da.period_end_at) + "</span></div>" +
            "</div>");
        }
        var bal = "";
        if (bill) {
          bal += '<div style="display:flex;align-items:center;gap:6px"><span style="font-size:15px;font-weight:600;font-variant-numeric:tabular-nums">' + fmt(bill.effective_available_points) + "</span>" +
            (bill.is_exhausted ? tag("已耗尽", "#e5b94c") : "") +
            '<span style="font-size:11px;color:var(--cqw-muted)">充值积分</span>' +
            (Number(bill.recharged_points) ? '<span style="font-size:10px;color:var(--cqw-muted)">累计 ' + fmt(bill.recharged_points) + "</span>" : "") +
            "</div>";
        }
        if (g && g.remaining_points != null) {
          bal += '<div style="font-size:11px"><span style="color:#8ab949">赠送</span> ' + fmt(g.remaining_points) + (g.expirations && g.expirations.length ? "，" + g.expirations.length + " 笔待到期" : "") + "</div>";
        }
        if (bal) ch.push('<div style="border:1px solid var(--cqw-cardBorder);border-radius:10px;padding:8px 10px;background:var(--cqw-card)">' + bal + "</div>");

        var wr = "";
        if (cp && cp.found && Array.isArray(cp.windows) && cp.windows.length) {
          for (var i = 0; i < cp.windows.length; i++) {
            var w = cp.windows[i];
            var label = WIN_LABEL[w.window_type] || w.window_type;
            wr += '<div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:11px"><span>' + label + (w.exhausted ? " " + tag("用尽", "#e5484d") : "") + '</span><span>剩 <b>' + fmt(w.remaining_points) + "</b> / " + fmt(w.quota_points) + "</span></div>" +
              bar(usedPct(w.used_points, w.quota_points)) +
              '<div style="font-size:10px;color:var(--cqw-muted);margin-top:1px">已用 ' + fmt(w.used_points) + (w.next_boundary_at ? " · 下次刷新 " + pt(w.next_boundary_at) : "") + "</div></div>";
          }
        } else if (cp && !cp.found) {
          wr = '<div style="font-size:11px;color:var(--cqw-muted)">无订阅套餐窗口（免费版）。付费后显示 <b>5小时 / 周 / 月</b> 用量窗。</div>';
        }
        if (wr) ch.push('<div style="border:1px solid var(--cqw-cardBorder);border-radius:10px;padding:8px 10px;background:var(--cqw-card)"><div style="font-size:11px;color:var(--cqw-muted);margin-bottom:4px">套餐窗口限额</div>' + wr + "</div>");

        if (t) {
          var period = data.period || {};
          ch.push('<div style="border:1px solid var(--cqw-cardBorder);border-radius:10px;padding:8px 10px;background:var(--cqw-card)">' +
            '<div style="font-size:11px;color:var(--cqw-muted);margin-bottom:4px">本月 ' + (period.start_date || "?") + " ~ " + (period.end_date || "?") + "</div>" +
            '<div style="display:flex;gap:14px;flex-wrap:wrap">' +
            '<div><b style="font-size:14px;font-variant-numeric:tabular-nums">' + fmt(t.recorded_points) + '</b><div style="font-size:10px;color:var(--cqw-muted)">消耗积分</div></div>' +
            '<div><b style="font-size:14px;font-variant-numeric:tabular-nums">' + fmt(t.settlement_count) + '</b><div style="font-size:10px;color:var(--cqw-muted)">结算次数</div></div>' +
            '<div><b style="font-size:14px;font-variant-numeric:tabular-nums">' + fmt((t.prompt_tokens || 0) + (t.completion_tokens || 0)) + '</b><div style="font-size:10px;color:var(--cqw-muted)">总令牌</div></div>' +
            "</div></div>");
        }
        bodyEl.innerHTML = ch.join("") || '<div style="color:var(--cqw-muted);font-size:11px">暂无数据</div>';
        if (lastErr) {
          bannerEl.style.display = "block";
          bannerEl.innerHTML = "<b>注意：</b>" + esc(lastErr);
        } else {
          bannerEl.style.display = "none";
        }
        var rl = data.rateLimit;
        footEl.textContent = (rl && rl.rpm_limit != null ? "速率 " + rl.rpm_limit + " RPM · " : "") + pt(data.fetchedAt) + " 更新 · 按住圆环可拖动";
      }

      function tick() {
        if (!proxyOk) return;
        if (lastOk) ageEl.textContent = Math.max(0, Math.round((Date.now() - lastOk) / 1000)) + "s 前";
        var da = data && data.dailyAllowance;
        var node = wrapper.querySelector('[data-cq="countdown"]');
        if (da && da.period_end_at && node) {
          var ms = new Date(da.period_end_at).getTime() - Date.now();
          if (ms > 0) {
            var hh = Math.floor(ms / 3600000), mm = Math.floor((ms % 3600000) / 60000), ss = Math.floor((ms % 60000) / 1000);
            node.textContent = "距重置 " + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
          } else node.textContent = "窗口到期";
        }
      }

      function setVisible(v) {
        if (visible === v) return;
        visible = v;
        wrapper.style.display = v ? "block" : "none";
        if (!v) closePanel();
      }

      function showPanel() {
        panelOpen = true;
        panel.style.display = "block";
        renderBody();
        tick();
      }
      function closePanel() {
        panelOpen = false;
        panel.style.display = "none";
      }
      function togglePanel() {
        if (panelOpen) closePanel(); else {
          showPanel();
        }
      }

      /* ── 数据 ── */
      function refreshQuota(force) {
        refreshBtn.disabled = true;
        return fetch(API + "/quota" + (force ? "?force=1" : ""), { cache: "no-store" })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (j) {
            if (!j || !j.ok) throw new Error(j && j.error ? j.error : "HTTP ?");
            data = j.data;
            lastOk = Date.now();
            lastErr = "";
            ringState();
            if (panelOpen) { renderBody(); tick(); }
          })
          .catch(function (e) {
            lastErr = String((e && e.message) || e);
            if (panelOpen) renderBody();
          })
          .finally(function () { refreshBtn.disabled = false; });
      }

      function checkHealth() {
        return fetch(API + "/health", { cache: "no-store" })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (j) {
            proxyOk = !!(j && j.proxyUp);
            if (j && j.refreshMs) refreshMs = Number(j.refreshMs) || 30000;
          })
          .catch(function () { proxyOk = false; })
          .then(function () {
            setVisible(proxyOk);
            if (proxyOk) {
              ringState();
              tick();
              if (!lastOk || !data) return refreshQuota(false);
            } else {
              data = null;
              lastOk = 0;
              lastErr = "本地代理未启动（codely-dsh-bridge），额度圈暂停显示";
            }
            return void 0;
          });
      }

      /* ── 交互：点击展开 / 点外部关闭 / 拖拽 ── */
      pet.addEventListener("click", function (e) {
        e.stopPropagation();
        togglePanel();
      });

      function onDocClick(e) {
        if (panelOpen && !wrapper.contains(e.target)) closePanel();
      }
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closePanel();
      });

      // 拖拽（pointer events）
      var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
      pet.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        moved = false;
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        var rect = wrapper.getBoundingClientRect();
        ox = rect.left; oy = rect.top;
        pet.setPointerCapture && pet.setPointerCapture(e.pointerId);
      });
      pet.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        if (moved) {
          wrapper.style.left = ox + dx + "px";
          wrapper.style.top = oy + dy + "px";
          wrapper.style.right = "auto";
          wrapper.style.bottom = "auto";
        }
      });
      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        if (moved) {
          try {
            localStorage.setItem(POS_KEY, JSON.stringify({ left: ox + (e.clientX - sx), top: oy + (e.clientY - sy) }));
          } catch (err) { /* 忽略 */ }
        }
      }
      pet.addEventListener("pointerup", endDrag);
      pet.addEventListener("pointercancel", endDrag);

      refreshBtn.addEventListener("click", function (e) { e.stopPropagation(); void refreshQuota(true); });

      /* ── 主题跟随：dsh 切换主题（body[data-ds-dark-theme]）时实时换肤 ── */
      var themeObserver = null;
      if (typeof MutationObserver !== "undefined" && document.body) {
        themeObserver = new MutationObserver(function () { applyThemeVars(wrapper); });
        themeObserver.observe(document.body, { attributes: true, attributeFilter: [THEME_ATTR] });
      }

      /* ── 定时器 ── */
      timers.push(window.setInterval(function () { void checkHealth(); }, healthMs));
      timers.push(window.setInterval(function () {
        if (proxyOk && !document.hidden) void refreshQuota(false);
      }, refreshMs));
      timers.push(window.setInterval(function () { tick(); }, 1000));

      /* 首轮启动 */
      void checkHealth();

      /* ── 卸载 ── */
      return function dispose() {
        if (disposed) return;
        disposed = true;
        timers.forEach(function (t) { clearInterval(t); timers = []; });
        if (themeObserver) themeObserver.disconnect();
        document.removeEventListener("click", onDocClick, true);
        if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
      };
    }

    module.exports = {
      inject: ["slots"],
      apply: function (ctx) {
        ctx.effect(function () {
          if (activeDispose) { try { activeDispose(); } catch (e) { /* 忽略 */ } }
          activeDispose = buildPet();
          return function () {
            try { activeDispose(); } catch (e) { /* 忽略 */ }
            activeDispose = null;
          };
        }, "@dsh-external/dsh-codely-quota: pet");
      },
    };

    return module.exports;
  },
});