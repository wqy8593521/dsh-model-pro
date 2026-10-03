/** CSS styles for the redesigned Model Pro settings page.
 * Built on DSW alias tokens so it lives cleanly inside the DSH settings app.
 * Visual system: state-led rail cards (left rail encodes lifecycle), a soft
 * segmented filter bar, mono type for anything the machine reads (route /
 * baseURL / model ids / latency), and a highlighted connectivity-test verdict. */

const FONT_MONO =
  'var(--dsw-font-mono, ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace)'

export const CSS = [
  // ---------- roots ----------
  '.mpro-root{--mpro-gap:14px;--mpro-radius:12px;--mpro-radius-sm:7px;--mpro-monospace:' + FONT_MONO + ';max-width:820px;margin:0 auto;padding:2px 0 48px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}',
  '.mpro-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}',
  '.mpro-headLeft{min-width:0}',
  '.mpro-title{font-size:20px;font-weight:650;margin:0;letter-spacing:-0.015em}',
  '.mpro-titleNote{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
  '.mpro-headActions{display:flex;gap:8px;align-items:center;flex:none}',
  '.mpro-intro{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6;margin:10px 0 16px;max-width:640px}',

  // ---------- buttons ----------
  '.mpro-btn{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;font-family:inherit;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s,transform .05s;display:inline-flex;align-items:center;gap:5px}',
  '.mpro-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-stronger,var(--dsw-alias-border-l2))}',
  '.mpro-btn:active:not(:disabled){transform:translateY(1px)}',
  '.mpro-btn:disabled{opacity:.45;cursor:not-allowed}',
  '.mpro-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
  // Primary fill must follow the DSW button pair: `brand-primary` inverts per
  // theme (near-black in light, near-white in dark), so pairing it with a hard
  // `#fff` label rendered white-on-white in dark mode.
  '.mpro-btnPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}',
  '.mpro-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)));border-color:transparent}',
  '.mpro-btnDanger{color:var(--dsw-alias-state-error-primary);border-color:transparent}',
  '.mpro-btnDanger:hover:not(:disabled){background:var(--dsw-alias-state-error-fill,var(--dsw-alias-interactive-bg-hover-danger))}',
  '.mpro-btnGhost{border-color:transparent;color:var(--dsw-alias-label-secondary)}',
  '.mpro-btnSm{height:25px;padding:0 9px;font-size:11.5px;border-radius:6px}',
  '.mpro-btnWide{flex:1}',

  '.mpro-gatewayBox{margin-top:12px;padding:13px 14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-3),transparent);display:flex;flex-direction:column;gap:9px}',
  '.mpro-gatewayBoxLive{border-style:solid;border-color:var(--dsw-alias-state-success-primary);box-shadow:inset 3px 0 0 var(--dsw-alias-state-success-primary)}',
  '.mpro-gatewayState{font-family:var(--mpro-monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;gap:6px}',
  '.mpro-gatewayLed{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-quaternary);box-shadow:0 0 0 3px var(--dsw-alias-bg-layer-2)}',
  '.mpro-gatewayStateLive{color:var(--dsw-alias-state-success-label)}',
  '.mpro-gatewayStateLive .mpro-gatewayLed{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-success-fill),0 0 9px var(--dsw-alias-state-success-primary)}',
  '.mpro-gatewayPatch{display:flex;flex-direction:column;gap:10px;padding:10px;border-left:2px solid var(--dsw-alias-border-l2);margin-left:3px}',
  '.mpro-gatewaySocket{display:flex;align-items:center;gap:10px;min-width:0;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
  '.mpro-gatewaySocketLabel{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);flex:none}',
  '.mpro-gatewaySocket code{font-family:var(--mpro-monospace);font-size:11px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}',
  '.mpro-gatewayIssued{padding:9px 10px;border-radius:6px;background:var(--dsw-alias-state-warn-fill,rgba(217,119,6,.12));display:flex;flex-direction:column;gap:4px}',
  '.mpro-gatewayIssued span{font-size:11px;color:var(--dsw-alias-state-warn-label)}',
  '.mpro-gatewayIssued code{font-family:var(--mpro-monospace);font-size:11px;overflow-wrap:anywhere;user-select:all}',

  // ---------- banner ----------
  '.mpro-banner{padding:9px 12px;border-radius:8px;font-size:12px;margin:12px 0;display:flex;gap:8px;align-items:center;line-height:1.45}',
  '.mpro-bannerOk{background:var(--dsw-alias-state-success-fill);color:var(--dsw-alias-state-success-label)}',
  '.mpro-bannerErr{background:var(--dsw-alias-state-error-fill,var(--dsw-alias-state-error-soft,rgba(220,38,38,.12)));color:var(--dsw-alias-state-error-label)}',
  '.mpro-bannerWarn{background:var(--dsw-alias-state-warn-fill,var(--dsw-alias-state-warn-soft,rgba(217,119,6,.14)));color:var(--dsw-alias-state-warn-label)}',

  // ---------- segments ----------
  '.mpro-segs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 16px;padding:4px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;width:max-content;max-width:100%}',
  '.mpro-seg{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:7px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;font-family:inherit;cursor:pointer;transition:background .12s,color .12s}',
  '.mpro-seg:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.mpro-segActive{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.25)}',
  '.mpro-segCount{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:18px;text-align:center}',
  '.mpro-segActive .mpro-segCount{color:var(--dsw-alias-brand-primary)}',

  // ---------- provider cards ----------
  '.mpro-pcList{display:flex;flex-direction:column;gap:10px}',
  '.mpro-pc{position:relative;display:flex;align-items:center;gap:14px;padding:13px 14px 13px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--mpro-radius);background:var(--dsw-alias-bg-layer-2);transition:border-color .12s,transform .06s}',
  '.mpro-pc:hover{border-color:var(--dsw-alias-border-l2)}',
  '.mpro-pc::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:3px;background:var(--mpro-rail,var(--dsw-alias-label-quaternary))}',
  '.mpro-pcActive{--mpro-rail:var(--dsw-alias-state-success-primary)}',
  '.mpro-pcOff{--mpro-rail:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warn-label))}',
  '.mpro-pcMain{flex:1;min-width:0}',
  '.mpro-pcNameRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
  '.mpro-pcName{font-size:14px;font-weight:600;letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
  '.mpro-pcRoute{font-family:var(--mpro-monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3);padding:1px 6px;border-radius:4px;white-space:nowrap}',
  '.mpro-pcChips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}',
  '.mpro-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
  '.mpro-chipMono{font-family:var(--mpro-monospace);font-size:10.5px}',
  '.mpro-chipGood{color:var(--dsw-alias-state-success-label);}',
  '.mpro-chipMiss{color:var(--dsw-alias-label-quaternary);border-style:dashed}',
  '.mpro-pcActions{display:flex;gap:6px;align-items:center;flex:none;flex-wrap:wrap;justify-content:flex-end}',

  // ---------- pills ----------
  '.mpro-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.01em;white-space:nowrap}',
  '.mpro-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}',
  '.mpro-pillActive{background:var(--dsw-alias-state-success-fill,var(--dsw-alias-state-success-soft,rgba(22,163,74,.14)));color:var(--dsw-alias-state-success-label,var(--dsw-alias-state-success-primary))}',
  '.mpro-pillOff{background:var(--dsw-alias-state-warn-fill,var(--dsw-alias-state-warn-soft,rgba(217,119,6,.15)));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}',

  // ---------- generic card / form ----------
  '.mpro-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--mpro-radius);overflow:hidden}',
  '.mpro-cardHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.mpro-cardTitle{font-size:13px;font-weight:600;margin:0}',
  '.mpro-cardBody{padding:16px;display:flex;flex-direction:column;gap:14px}',
  '.mpro-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
  '.mpro-fieldLabel{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}',
  '.mpro-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;margin:0}',
  '.mpro-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;transition:border-color .12s,box-shadow .12s}',
  '.mpro-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px var(--dsw-alias-brand-primary-alpha-15,rgba(99,102,241,.12))}',
  '.mpro-input::placeholder{color:var(--dsw-alias-label-quaternary)}',
  '.mpro-inputMono{font-family:var(--mpro-monospace);font-size:12px}',
  '.mpro-select{appearance:auto;cursor:pointer}',
  '.mpro-inlineErr{font-size:11px;color:var(--dsw-alias-state-error-primary)}',
  // Inline failure text for a lookup or a write that did not happen. Same metrics
  // as .mpro-hint (these sit in the same paragraph stack) but in the error colour,
  // so a failed prefill does not read as ordinary explanatory copy.
  '.mpro-verdictErr{font-size:11px;line-height:1.5;margin:0;color:var(--dsw-alias-state-error-primary)}',
  '.mpro-formFooter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding-top:4px}',
  '.mpro-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
  '.mpro-grid2 .mpro-fieldFull{grid-column:1/-1}',

  // ---------- create wizard ----------
  '.mpro-steps{display:flex;flex-direction:column;gap:2px}',
  '.mpro-step{padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;gap:9px}',
  '.mpro-stepLabel{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',

  // ---------- editor ----------
  '.mpro-editorHead{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}',
  '.mpro-editorTitle{font-size:16px;font-weight:650;margin:0;letter-spacing:-0.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mpro-editorRoute{font-family:var(--mpro-monospace);font-size:12px;color:var(--dsw-alias-label-tertiary)}',
  '.mpro-editorActions{margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
  '.mpro-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 8px;overflow-x:auto}',
  '.mpro-tab{padding:10px 14px;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary);cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;transition:color .12s,border-color .12s;font-family:inherit;white-space:nowrap}',
  '.mpro-tab:hover{color:var(--dsw-alias-label-primary)}',
  '.mpro-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:4px}',
  '.mpro-tabActive{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary)}',
  '.mpro-tabCount{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:2px;font-variant-numeric:tabular-nums}',
  '.mpro-panel{padding:16px;display:flex;flex-direction:column;gap:16px}',

  // ---------- overview ----------
  '.mpro-overviewGrid{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;align-items:start}',
  '.mpro-sectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0 0 10px;letter-spacing:.02em;text-transform:uppercase}',
  '.mpro-setupCard{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px}',
  '.mpro-setupItem{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.mpro-setupDot{flex:none;width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700}',
  '.mpro-setupDone .mpro-setupDot{background:var(--dsw-alias-state-success-fill,var(--dsw-alias-state-success-soft,rgba(22,163,74,.15)));color:var(--dsw-alias-state-success-primary)}',
  '.mpro-setupTodo .mpro-setupDot{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-quaternary)}',
  '.mpro-setupTodo{color:var(--dsw-alias-label-tertiary)}',
  '.mpro-setupGo{display:inline-flex;align-items:center;gap:4px;margin-top:8px;padding:4px 10px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary-alpha-10,rgba(99,102,241,.08));border:none;border-radius:6px;cursor:pointer;font-family:inherit}',
  '.mpro-setupGo:hover{background:var(--dsw-alias-brand-primary-alpha-15,rgba(99,102,241,.14))}',

  // ---------- headers ----------
  '.mpro-hdrRow{display:grid;grid-template-columns:170px 1fr 30px;gap:8px;align-items:center;margin-bottom:8px}',
  '.mpro-hdrAdd{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',

  // ---------- models ----------
  '.mpro-discoverBar{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding:12px 14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base)}',
  '.mpro-searchInput{flex:1 1 160px;min-width:150px;max-width:280px;height:28px;font-size:11.5px}',
  '.mpro-addBar{margin-top:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;gap:10px}',
  '.mpro-addBarHead{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}',
  '.mpro-addBarRow{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}',
  '.mpro-modelBar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
  '.mpro-modelBar .mpro-right{margin-left:auto}',
  '.mpro-chipSel{background:var(--dsw-alias-brand-primary-alpha-15,rgba(99,102,241,.13));color:var(--dsw-alias-brand-primary);border-color:transparent}',
  '.mpro-capabilityCell{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
  '.mpro-capabilitySelect{min-width:145px;width:auto}',
  '.mpro-capabilityUnknown{color:var(--dsw-alias-label-tertiary)}',
  '.mpro-tblWrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;max-height:320px}',
  '.mpro-tbl{width:100%;border-collapse:collapse;font-size:12px}',
  '.mpro-tbl th{position:sticky;top:0;text-align:left;padding:7px 10px;font-weight:600;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3);white-space:nowrap;z-index:1}',
  '.mpro-tbl td{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums}',
  '.mpro-tbl tr:last-child td{border-bottom:none}',
  '.mpro-tbl tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.mpro-tblCk{text-align:center;width:30px}',
  '.mpro-tbl .mpro-id{font-family:var(--mpro-monospace);font-size:11.5px}',
  '.mpro-tbl .mpro-dim{color:var(--dsw-alias-label-tertiary)}',

  // ---------- test ----------
  '.mpro-testCard{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);padding:14px;display:flex;flex-direction:column;gap:12px}',
  '.mpro-testRow{display:grid;grid-template-columns:1fr 140px;gap:12px}',
  '.mpro-verdict{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border-radius:10px;border:1px solid var(--mpro-rail,var(--dsw-alias-border-l1))}',
  '.mpro-verdictOk{--mpro-rail:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-fill,var(--dsw-alias-state-success-soft,rgba(22,163,74,.12)));border-color:var(--dsw-alias-state-success-primary)}',
  '.mpro-verdictFail{--mpro-rail:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-fill,var(--dsw-alias-state-error-soft,rgba(220,38,38,.12)));border-color:var(--dsw-alias-state-error-primary)}',
  '.mpro-verdictTitle{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}',
  '.mpro-verdictMeta{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.mpro-verdictMeta b{font-family:var(--mpro-monospace);font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.mpro-resultBlock{margin-top:2px}',
  '.mpro-resultLabel{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px}',
  '.mpro-reply{font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);font-family:var(--mpro-monospace);font-size:12px}',
  '.mpro-errorBlock{font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-state-error-fill,var(--dsw-alias-state-error-soft,rgba(220,38,38,.1)));color:var(--dsw-alias-state-error-label);border:1px solid var(--dsw-alias-state-error-primary)}',
  '.mpro-testing{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
  '.mpro-spin{width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:mpro-spin .7s linear infinite}',
  '@keyframes mpro-spin{to{transform:rotate(360deg)}}',

  // ---------- misc ----------
  '.mpro-emptyState{padding:30px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:1.6}',
  '.mpro-inlineStatus{font-size:11.5px;padding:2px 0}',
  '.mpro-inlineStatusOk{color:var(--dsw-alias-state-success-primary)}',
  '.mpro-inlineStatusErr{color:var(--dsw-alias-state-error-primary)}',

  // ---------- smart-routing page (routes/composite/obs/probe) ----------
  '.mpro-routesRoot{display:flex;flex-direction:column;gap:14px}',
  '.mpro-routesTabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 8px;overflow-x:auto;margin-bottom:14px}',
  '.mpro-routesTab{padding:10px 14px;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary);cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;transition:color .12s,border-color .12s;font-family:inherit;white-space:nowrap}',
  '.mpro-routesTab:hover{color:var(--dsw-alias-label-primary)}',
  '.mpro-routesTabActive{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary)}',
  '.mpro-routesTabCount{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:2px;font-variant-numeric:tabular-nums}',
  '.mpro-routeRow{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}',
  '.mpro-routeRow:hover{border-color:var(--dsw-alias-border-l2)}',
  '.mpro-routeMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
  '.mpro-routeNameRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.mpro-routeName{font-size:13px;font-weight:650;letter-spacing:-0.01em}',
  '.mpro-routeChain{font-family:var(--mpro-monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;display:block}',
  '.mpro-routeW{font-family:var(--mpro-monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
  '.mpro-routeActions{display:flex;gap:6px;align-items:center;flex:none}',
  // Target rows are drag-reorderable: a grip + ordinal lead each row, and the
  // ↑/↓ buttons are the keyboard-accessible equivalent of dragging.
  '.mpro-targetRow{display:grid;grid-template-columns:14px 18px 1fr 1fr 62px auto auto 26px;gap:8px;align-items:center;padding:2px 0;border-radius:8px;border:1px solid transparent}',
  '.mpro-targetRow .mpro-weight{width:62px}',
  '.mpro-targetRow .mpro-enabledCk{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.mpro-dragHandle{cursor:grab;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;text-align:center;user-select:none}',
  '.mpro-targetRow:active .mpro-dragHandle{cursor:grabbing}',
  '.mpro-targetIdx{font-family:var(--mpro-monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary);text-align:center;font-variant-numeric:tabular-nums}',
  // The drop indicator is a top border so it reads as "insert above this row".
  '.mpro-targetRowOver{border-color:var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));background:var(--dsw-alias-bg-layer-3)}',
  '.mpro-moveBtns{display:flex;gap:2px}',
  '.mpro-moveBtn{width:20px;height:22px;padding:0;font-size:10px;line-height:1;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.mpro-moveBtn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
  '.mpro-moveBtn:disabled{opacity:.35;cursor:default}',
  '.mpro-cfgGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
  '.mpro-cfgGrid .mpro-cfgFull{grid-column:1/-1}',
  // Retry budget — global to the router/composite provider routes.
  '.mpro-retryBox{display:flex;flex-direction:column;gap:6px;margin-top:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
  '.mpro-retryHead{display:flex;align-items:center;gap:8px;justify-content:space-between}',
  '.mpro-retryRow{display:flex;align-items:center;gap:10px}',
  '.mpro-retrySlider{flex:1;min-width:0;accent-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary))}',
  '.mpro-retryValue{font-family:var(--mpro-monospace);font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);min-width:34px;text-align:right}',
  '.mpro-previewBox{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}',
  '.mpro-previewCount{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}',
  '.mpro-previewChips{display:flex;flex-wrap:wrap;gap:6px}',
  '.mpro-toggleCk{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;cursor:pointer;user-select:none}',
  '.mpro-toggleCk input{accent-color:var(--dsw-alias-brand-primary)}',
  '.mpro-checkRow{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
  '.mpro-checkRow input{accent-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary))}',

  // Thinking levels (reasoningEfforts) — list cell + per-model editor.
  '.mpro-reasonCell{display:flex;align-items:center;gap:8px}',
  '.mpro-reasonTag{font-family:var(--mpro-monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
  '.mpro-reasonBox{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
  '.mpro-reasonHead{display:flex;align-items:center;gap:8px;font-size:12px}',
  '.mpro-reasonModes{display:flex;gap:6px;flex-wrap:wrap}',
  '.mpro-reasonModes .mpro-pill{cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
  '.mpro-reasonLookup{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.mpro-reasonCands{display:flex;flex-direction:column;gap:6px}',
  '.mpro-reasonCand{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}',
  '.mpro-tierTag{font-size:10px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
  '.mpro-tierExact{background:var(--dsw-alias-state-success-fill,rgba(22,163,74,.14));color:var(--dsw-alias-state-success-label,var(--dsw-alias-state-success-primary))}',
  '.mpro-reasonLevels{font-family:var(--mpro-monospace);font-size:11px;color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-primary))}',
  '.mpro-reasonFrom{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}',
  '.mpro-reasonActions{display:flex;gap:8px}',
  // Alternate-candidate switcher inside the bulk-fill preview: one pill per
  // competing declaration, labelled with its level count (the ids that differ
  // between deployments are exactly the ones worth a second look).
  '.mpro-reasonAlt{display:inline-flex;gap:4px;margin-left:8px;vertical-align:middle}',
  '.mpro-pillSm{cursor:pointer;padding:1px 7px;font-size:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
  '.mpro-pillSm::before{display:none}',

  // stat cards
  '.mpro-statGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}',
  '.mpro-statCard{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}',
  '.mpro-statLabel{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;text-transform:uppercase}',
  '.mpro-statValue{font-size:18px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-0.02em}',
  '.mpro-statValueGood{color:var(--dsw-alias-state-success-primary)}',
  '.mpro-statValueBad{color:var(--dsw-alias-state-error-primary)}',
  '.mpro-statSub{font-size:11px;color:var(--dsw-alias-label-tertiary)}',

  // health dots
  '.mpro-hdot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}',
  '.mpro-hdotUp{background:var(--dsw-alias-state-success-primary)}',
  '.mpro-hdotDown{background:var(--dsw-alias-state-error-primary)}',
  '.mpro-hdotUnknown{background:var(--dsw-alias-label-quaternary)}',
  '.mpro-hdotProbing{background:var(--dsw-alias-brand-primary);animation:mpro-pulse 1s ease-in-out infinite}',
  '.mpro-hdotRow{display:flex;align-items:center;gap:8px}',
  '.mpro-healthText{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--mpro-monospace)}',
  '@keyframes mpro-pulse{0%,100%{opacity:.35}50%{opacity:1}}',

  // log / health tables
  '.mpro-obsGrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}',
  '.mpro-pctCell{font-variant-numeric:tabular-nums}',
  '.mpro-logStatus{font-weight:600}',
  '.mpro-logOk{color:var(--dsw-alias-state-success-primary)}',
  '.mpro-logErr{color:var(--dsw-alias-state-error-primary)}',
  // Thinking-level cell. A CLAMPED level is a successful call that silently ran
  // at a level other than the one requested, so it needs to stand out from
  // ordinary text without reading as an error.
  '.mpro-logEffort{font-family:var(--mpro-monospace);font-size:11px;white-space:nowrap}',
  '.mpro-logEffortClamped{color:var(--dsw-alias-state-warning-primary,#b45309);font-weight:600;cursor:help}',
  '.mpro-tblRow{display:grid;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}',
  '.mpro-tblRow:last-child{border-bottom:none}',
  // request-log toolbar + pagination + expandable error rows
  '.mpro-logHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px}',
  '.mpro-logFilters{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.mpro-segGroup{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}',
  '.mpro-seg{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11.5px;font-weight:500;padding:5px 11px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;border-right:1px solid var(--dsw-alias-border-l1);transition:background .12s,color .12s}',
  '.mpro-seg:last-child{border-right:none}',
  '.mpro-seg:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.mpro-segOn{background:var(--dsw-alias-brand-primary-alpha-15,rgba(99,102,241,.14));color:var(--dsw-alias-brand-primary)}',
  '.mpro-segErr.mpro-segOn{background:var(--dsw-alias-state-error-fill,rgba(220,38,38,.13));color:var(--dsw-alias-state-error-primary)}',
  '.mpro-segNum{font-variant-numeric:tabular-nums;font-size:10.5px;opacity:.85;font-family:var(--mpro-monospace)}',
  '.mpro-pageSizeSel{width:auto;height:28px;font-size:11.5px;padding:0 8px}',
  '.mpro-logTbl td{cursor:default}',
  '.mpro-logCaret{color:var(--dsw-alias-label-quaternary);text-align:center;font-size:10px;width:26px}',
  '.mpro-logRowClickable{cursor:pointer}',
  '.mpro-logRowClickable:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.mpro-logRowErr td{background:var(--dsw-alias-state-error-fill,rgba(220,38,38,.05))}',
  '.mpro-logDetailRow td{padding:0!important;background:var(--dsw-alias-bg-layer-3)}',
  '.mpro-logDetail{padding:10px 14px;display:flex;flex-direction:column;gap:7px}',
  '.mpro-logDetailLabel{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.03em}',
  '.mpro-logDetailMeta{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
  '.mpro-logDetailMeta b{font-family:var(--mpro-monospace);color:var(--dsw-alias-label-secondary)}',
  '.mpro-errToggle{appearance:none;border:none;background:transparent;color:var(--dsw-alias-state-error-primary);font-family:inherit;font-size:11px;cursor:pointer;padding:0 2px;line-height:1}',
  '.mpro-errToggle:hover{text-decoration:underline}',
  '.mpro-pager{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:10px}',
  '.mpro-pagerInfo{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
  '.mpro-pagerBtns{display:flex;align-items:center;gap:5px}',
  '.mpro-pagerPos{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;padding:0 6px;min-width:56px;text-align:center}',

  // conversation turnTail badge (served-by provider)
  '.mpro-badgeRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
  '.mpro-badgeIcon{font-size:11px;line-height:1;color:var(--dsw-alias-label-quaternary)}',
  '.mpro-badgeLabel{font-size:10.5px;letter-spacing:.02em}',
  '.mpro-badgeChip{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px}',
  '.mpro-badgeChipMono{font-family:var(--mpro-monospace)}',
  '.mpro-badgeChipRoute{border-style:dashed;color:var(--dsw-alias-brand-primary)}',
  '.mpro-badgeFb{color:var(--dsw-alias-state-success-primary);font-weight:600}',
  '.mpro-badgeFbText{font-size:10.5px;color:var(--dsw-alias-state-success-primary)}',
  // Thinking-level substitution chip: a successful turn that ran at a level
  // other than the requested one. Warning-toned, not error-toned.
  '.mpro-badgeChipEffort{font-family:var(--mpro-monospace);color:var(--dsw-alias-state-warning-primary,#b45309);border-color:var(--dsw-alias-state-warning-primary,#b45309);cursor:help}',

  // ---------- responsive & motion ----------
  '@media(max-width:640px){.mpro-grid2,.mpro-overviewGrid,.mpro-testRow{grid-template-columns:1fr}.mpro-hdrRow{grid-template-columns:120px 1fr 28px}.mpro-pc{flex-wrap:wrap}.mpro-pcActions{width:100%;justify-content:flex-start}}',
  '@media(prefers-reduced-motion:reduce){.mpro-btn,.mpro-pc,.mpro-input,.mpro-seg,.mpro-tab,.mpro-spin{transition:none;animation:none}}',
].join('\n')
