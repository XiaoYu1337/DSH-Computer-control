/**
 * dsh-computer-control · Client half
 *
 * 挂在 `shell.overlay`（frame-wide 浮层，默认 click-through）上，负责接管状态的可视化：
 *   - active：屏幕四边缓慢呼吸的「雾状绿光」+ 顶部胶囊「Agent正在操控此电脑」；
 *   - paused：用户点击鼠标接管后，绿光退出，顶部显示「用户正在操控电脑-点击继续」，
 *     其中「点击继续」是蓝色可点击文字；点击后通过 RPC 把控制权交还 Agent；
 *   - idle：完全隐藏。
 *
 * 状态由宿主半维护，客户端每 600ms（idle 时 2s）轮询一次 RPC 通道。
 * 这里只使用种子模块 `react`，图标用内联 SVG，样式全部写在本组件内（卸载即清理）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-computer-control',
  factory: (require) => {
    const React = require('react');
    const h = (type, props, ...children) => React.createElement(type, props ?? null, ...children.flat());

    /** 与宿主半约定的 RPC 通道。 */
    const RPC_CHANNEL = '/dsh-computer-control';
    const ENDPOINT_STATE = 'state';
    const ENDPOINT_RESUME = 'resume';
    const NS = 'computerControl';

    /** 简体中文字典。 */
    const zh = {
      'banner.agent': 'Agent正在操控此电脑',
      'banner.user': '用户正在操控电脑-',
      'banner.resume': '点击继续',
      'banner.resume.label': '把控制权交还给 Agent',
    };
    /** English dictionary. */
    const en = {
      'banner.agent': 'Agent is controlling this computer',
      'banner.user': 'You are controlling this computer-',
      'banner.resume': 'Click to continue',
      'banner.resume.label': 'Give control back to the Agent',
    };

    /** 没有 locale 服务时的兜底文案。 */
    const fallback = (key) => {
      const dict = String(navigator.language ?? '').toLowerCase().startsWith('zh') ? zh : en;
      return dict[key] ?? key;
    };

    /** 通过客户端 connection 服务调用宿主半。 */
    const rpcCall = async (ctx, endpoint) => {
      const result = await ctx.connection.rpc.call(RPC_CHANNEL, endpoint, {});
      if (result !== null && typeof result === 'object' && result.ok === true) return result.value;
      const error = result?.error;
      throw new Error(typeof error === 'string' ? error : (error?.message ?? `RPC failed: ${endpoint}`));
    };

    /** 四边雾状绿光 + 顶部接管提示。 */
    function ComputerControlOverlay(props) {
      const { ctx } = props;
      const t = React.useMemo(() => {
        if (typeof props.t === 'function') return props.t;
        try {
          if (ctx?.locale?.bind) {
            const bound = ctx.locale.bind(NS);
            return (key) => bound(key);
          }
        } catch {
          // locale 服务尚未就绪：走兜底字典
        }
        return fallback;
      }, [ctx, props.t]);

      const [state, setState] = React.useState(() => ({
        mode: 'idle',
        version: -1,
        since: 0,
        overlay: 'native',
        caption: '',
        captionUntil: 0,
      }));
      const [resuming, setResuming] = React.useState(false);
      const modeRef = React.useRef(state.mode);
      modeRef.current = state.mode;
      const mountedRef = React.useRef(true);

      // 轮询宿主状态：active/paused 时 600ms，idle 时 2s。
      React.useEffect(() => {
        mountedRef.current = true;
        let cancelled = false;
        let timer = null;
        const tick = async () => {
          if (cancelled) return;
          try {
            const next = await rpcCall(ctx, ENDPOINT_STATE);
            if (!cancelled && next !== null && typeof next === 'object' && typeof next.mode === 'string') {
              setState((previous) =>
                previous.mode === next.mode &&
                previous.version === next.version &&
                previous.overlay === next.overlay &&
                previous.caption === (next.caption ?? '') &&
                previous.captionUntil === (next.captionUntil ?? 0)
                  ? previous
                  : {
                      mode: next.mode,
                      version: next.version,
                      since: next.since ?? Date.now(),
                      overlay: next.overlay === 'web' ? 'web' : 'native',
                      caption: String(next.caption ?? ''),
                      captionUntil: Number(next.captionUntil ?? 0),
                    },
              );
            }
          } catch {
            // 宿主半未就绪/重启中：保持现状，下次再试
          }
          if (cancelled) return;
          timer = setTimeout(tick, modeRef.current === 'idle' ? 2000 : 600);
        };
        void tick();
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return;
          if (timer !== null) clearTimeout(timer);
          void tick();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          cancelled = true;
          mountedRef.current = false;
          if (timer !== null) clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [ctx]);

      /** 用户点「点击继续」：恢复 Agent 控制。 */
      const onResume = React.useCallback(
        async (event) => {
          event.stopPropagation();
          if (resuming) return;
          setResuming(true);
          try {
            const next = await rpcCall(ctx, ENDPOINT_RESUME);
            if (mountedRef.current && next !== null && typeof next === 'object' && typeof next.mode === 'string') {
              setState({
                mode: next.mode,
                version: next.version,
                since: next.since ?? Date.now(),
                overlay: next.overlay === 'web' ? 'web' : 'native',
                caption: String(next.caption ?? ''),
                captionUntil: Number(next.captionUntil ?? 0),
              });
            }
          } catch {
            // 宿主半异常时保持 paused，用户可再点一次
          } finally {
            if (mountedRef.current) setResuming(false);
          }
        },
        [ctx, resuming],
      );

      /** 字幕到期后清掉，避免长时间停留在页面上。 */
      React.useEffect(() => {
        if (!state.caption || state.captionUntil <= 0) return undefined;
        const remaining = state.captionUntil - Date.now();
        if (remaining <= 0) return undefined;
        const timer = setTimeout(() => {
          if (!mountedRef.current) return;
          setState((previous) =>
            previous.caption === '' ? previous : { ...previous, caption: '', captionUntil: 0 },
          );
        }, remaining);
        return () => clearTimeout(timer);
      }, [state.caption, state.captionUntil]);

      const mode = state.mode;
      const paused = mode === 'paused';
      // 屏幕级原生浮层可用时，Web 浮层完全不渲染（避免两套提示叠加）；
      // 只有原生浮层不可用（非 Windows / 浮层进程启动失败）才回退到页内浮层。
      if (state.overlay !== 'web') return null;
      const visible = mode === 'active' || mode === 'paused';
      const captionVisible =
        visible && !paused && state.caption !== '' && state.captionUntil > Date.now();

      return h(
        'div',
        {
          className: 'cc-overlay',
          'data-mode': mode,
          'data-visible': visible ? 'true' : 'false',
          'aria-hidden': visible ? 'false' : 'true',
        },
        h('style', null, CSS),
        // 边框状呼吸光：细线 + 小范围柔光，中央完全不染色。
        h('div', { className: 'cc-frame', 'aria-hidden': 'true' }),
        visible
          ? h(
              'div',
              { className: 'cc-banner', 'data-mode': paused ? 'paused' : 'active', role: 'status' },
              h('span', { className: 'cc-dot', 'aria-hidden': 'true' }),
              h('span', { className: 'cc-text' }, paused ? t('banner.user') : t('banner.agent')),
              paused
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'cc-resume',
                      disabled: resuming,
                      title: t('banner.resume.label'),
                      'aria-label': t('banner.resume.label'),
                      onClick: onResume,
                    },
                    t('banner.resume'),
                  )
                : null,
            )
          : null,
        captionVisible
          ? h(
              'div',
              { className: 'cc-caption', role: 'status', 'aria-live': 'polite' },
              state.caption,
            )
          : null,
      );
    }

    /**
     * 浮层只在 active/paused 时可见；paused 时顶部胶囊内容整体 click-through，
     * 只有「点击继续」重新开启 pointer-events，其余区域永远不挡宿主应用。
     */
    const CSS = [
      '.cc-overlay{position:fixed;inset:0;z-index:2147483000;pointer-events:none;overflow:hidden;contain:layout style;opacity:0;visibility:hidden;transition:opacity .55s ease,visibility 0s linear .55s}',
      '.cc-overlay[data-visible="true"]{opacity:1;visibility:visible;transition:opacity .55s ease,visibility 0s linear 0s}',
      '.cc-overlay[data-mode="paused"] .cc-frame{opacity:0}',
      '.cc-frame{position:absolute;inset:0;pointer-events:none;border-radius:2px;box-shadow:inset 0 0 0 1.5px rgba(52,211,153,.58),inset 0 0 0 3px rgba(34,197,94,.24),inset 0 0 18px rgba(34,197,94,.16);animation:cc-border-breathe 5.4s ease-in-out infinite;transition:opacity .45s ease}',
      '.cc-banner{position:absolute;top:16px;left:50%;transform:translateX(-50%);display:inline-flex;align-items:center;gap:10px;max-width:min(92vw,760px);padding:10px 18px;border-radius:999px;border:1px solid rgba(52,211,153,.4);background:rgba(4,18,11,.84);box-shadow:0 12px 36px rgba(16,185,129,.3),0 2px 10px rgba(0,0,0,.4);backdrop-filter:blur(16px);color:#e9fff3;font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);font-size:13px;font-weight:500;line-height:20px;letter-spacing:.2px;white-space:nowrap;pointer-events:none;transition:background .45s ease,border-color .45s ease,box-shadow .45s ease}',
      '.cc-banner[data-mode="paused"]{top:64px;background:rgba(8,13,24,.88);border-color:rgba(96,165,250,.42);box-shadow:0 12px 36px rgba(37,99,235,.28),0 2px 10px rgba(0,0,0,.4);color:#eef4ff}',
      '.cc-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 10px #34d399,0 0 22px rgba(52,211,153,.65);animation:cc-pulse 1.9s ease-in-out infinite}',
      '.cc-banner[data-mode="paused"] .cc-dot{background:#93a6c4;box-shadow:none;animation:none}',
      '.cc-text{overflow:hidden;text-overflow:ellipsis}',
      '.cc-caption{position:absolute;top:66px;left:50%;transform:translateX(-50%);max-width:min(88vw,560px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:7px 14px;border-radius:999px;border:1px solid rgba(52,211,153,.34);background:rgba(4,18,11,.82);box-shadow:0 8px 24px rgba(16,185,129,.22),0 2px 8px rgba(0,0,0,.35);backdrop-filter:blur(12px);color:#d1fae5;font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);font-size:12px;font-weight:500;line-height:18px;letter-spacing:.2px;pointer-events:none}',
      '.cc-resume{pointer-events:auto;margin:0;padding:2px 4px;border:0;border-radius:4px;background:none;color:#4da3ff;font:inherit;font-weight:600;line-height:20px;cursor:pointer;text-decoration:none;transition:color .15s ease}',
      '.cc-resume:hover{color:#7cc0ff;text-decoration:underline}',
      '.cc-resume:focus-visible{outline:2px solid #4da3ff;outline-offset:2px}',
      '.cc-resume:disabled{opacity:.6;cursor:default;text-decoration:none}',
      '@keyframes cc-border-breathe{0%,100%{opacity:.62}50%{opacity:1}}',
      '@keyframes cc-pulse{0%,100%{opacity:.55;transform:scale(.86)}50%{opacity:1;transform:scale(1.08)}}',
      '@media (prefers-reduced-motion: reduce){.cc-frame,.cc-dot{animation:none}}',
    ].join('');

    /** 客户端半的 apply：注册字典 + 浮层。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'computer-control: dictionaries');
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-computer-control',
            order: 950,
            locale: NS,
          },
          (props) => h(ComputerControlOverlay, { ...props, ctx }),
        ),
      );
    }

    return {
      name: 'dsh-computer-control',
      inject: ['slots', 'locale', 'connection'],
      apply,
    };
  },
});
