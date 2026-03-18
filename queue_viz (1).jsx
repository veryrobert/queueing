import { useState, useEffect, useRef, useCallback } from "react";

// ─── Palette ─────────────────────────────────────────────────────────────────
const C = {
  bg: "#ffffff", card: "#ffffff", border: "#d8d8d3",
  text: "#1c1c1a", sub: "#555550", muted: "#9a9a94", dim: "#d0d0cb",
  stages: ["#fde872","#b8a9e8","#ff8a80","#6dd4d8","#4a6fe8","#72d9a0"],
};

// ─── Stage definitions ────────────────────────────────────────────────────────
// 0=Validation  1=Assessment  2=RFI  3=Consent  4=Decision  5=Done
const STAGES = [
  { id: "validation", label: "Validation" },
  { id: "assessment", label: "Assessment" },
  { id: "rfi",        label: "RFI"        },
  { id: "consent",    label: "Consent"    },
  { id: "decision",   label: "Decision"   },
  { id: "done",       label: "Done"       },
];

// ─── Physics constants ────────────────────────────────────────────────────────
const DOT_R   = 7;
const GRAVITY = 220;
const DAMPING = 0.28;
const FRICT   = 0.998;
const SEP     = DOT_R * 2.3;
const SIM_SPD_DEFAULT = 12;
const MAX     = 200;

// ─── Dot factory ─────────────────────────────────────────────────────────────
let _id = 0;
const mkDot = (x, y) => ({
  id: ++_id, stage: 0, target: 0,
  x, y,
  vx: (Math.random() - 0.5) * 20,
  vy: 0,
  days: 0,         // days spent in current stage
  totalDays: 0,    // cumulative days across all stages
  hadRfi: false,
  moving: false,   // true while travelling between zones
  falling: false,  // true when leaving done zone downward
  inService: false, // true when an assessor slot is assigned
});

// ─── Default params ───────────────────────────────────────────────────────────
const INIT = {
  interval:       7,   // one application every 7 days
  assessors:      18,  // ρ = 90/(18×7) ≈ 71% — stable but busy
  daysPerApp:    90,
  validationDays:120,
  rfiRate:       30,
  rfiDays:       60,
  decisionDays:  30,
  consentDays:   30,
  speed:          12,
};

// Format sim-days as  YY MM DDD
const fmtDays = d => {
  const dd = Math.floor(d);
  const yy = Math.floor(dd / 365);
  const mm = Math.floor((dd % 365) / 30);
  const ds = dd % 30;
  return (
    String(yy).padStart(2,"0") + "y " +
    String(mm).padStart(2,"0") + "m " +
    String(ds).padStart(2,"0") + "d"
  );
};

// ─── Slider (outside component — never remounts) ──────────────────────────────
const Slider = ({ label, min, max, unit, defaultVal, onChange }) => {
  const [v, setV] = useState(defaultVal);
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: C.sub }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.text }}>{v}{unit}</span>
      </div>
      <input type="range" min={min} max={max} defaultValue={defaultVal}
        onInput={e => { const n = +e.target.value; setV(n); onChange(n); }}
        style={{ width: "100%", touchAction: "none", cursor: "pointer" }} />
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────
export default function App() {
  const cvRef  = useRef(null);
  const stRef  = useRef({
    dots: [], zones: [], acc: 0, completed: 0,
    p: { ...INIT },
    completedWindow: [],
    _lastRho: 0,
    _elapsedDays: 0,
    _avgDays: 0,
    _throughputTotal: 0,
    _throughputCount: 0,
    _smoothAvg: 0,
    _zonePeak: [0,0,0,0,0,0], // rolling peak count per zone for normalisation
  });
  const rafRef = useRef(null);
  const t0Ref  = useRef(null);

  const [counters, setCounters] = useState({});
  const [open, setOpen]         = useState(false);
  const [params, setParams]     = useState({ ...INIT });

  // Direct write to stRef so animation loop picks up changes immediately
  const set = useCallback((k, v) => {
    stRef.current.p = { ...stRef.current.p, [k]: v };
    setParams(p => ({ ...p, [k]: v }));
  }, []);

  useEffect(() => {
    const cv  = cvRef.current;
    const ctx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    // Always vertical zones — full width, H/n each
    const buildZones = () => {
      const W = cv.offsetWidth, H = cv.offsetHeight;
      cv.width  = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stRef.current.zones = STAGES.map((_, i) => ({
        x: 0, y: i * H / STAGES.length, w: W, h: H / STAGES.length,
      }));
    };
    buildZones();
    const ro = new ResizeObserver(buildZones);
    ro.observe(cv);

    const loop = ts => {
      if (!t0Ref.current) t0Ref.current = ts;
      const dt  = Math.min((ts - t0Ref.current) / 1000, 0.05);
      t0Ref.current = ts;

      const s = stRef.current;
      const p = s.p;
      const dtS = dt * (p.speed || SIM_SPD_DEFAULT);
      s._elapsedDays += dtS;
      const Z = s.zones;
      if (!Z.length) {
        // Force build zones if not ready
        const W0 = cv.offsetWidth, H0 = cv.offsetHeight;
        if (W0 > 0 && H0 > 0) {
          stRef.current.zones = STAGES.map((_, i) => ({
            x: 0, y: i * H0 / STAGES.length, w: W0, h: H0 / STAGES.length,
          }));
        }
        rafRef.current = requestAnimationFrame(loop); return;
      }
      const W = cv.offsetWidth, H = cv.offsetHeight;

      // ── Spawn ────────────────────────────────────────────────────────────
      // λ = 1/interval arrivals per sim-day
      s.acc += (1 / Math.max(p.interval, 0.1)) * dtS;
      while (s.acc >= 1 && s.dots.length < MAX) {
        s.acc -= 1;
        const z = Z[0];
        s.dots.push(mkDot(
          z.x + z.w / 2 + (Math.random() - 0.5) * 30,
          -DOT_R * 2 - Math.random() * 40,
        ));
      }

      // ── Assessor capacity constraint (Theory of Constraints / M/M/c) ──
      // Count how many dots are actively IN service in assessment zone
      // Only p.assessors dots can be in service simultaneously
      // Dots in assessment queue (inService=false) must wait — their days don't accrue
      const inServiceCount = s.dots.filter(d => d.stage === 1 && d.inService && !d.moving).length;
      const slotsAvailable = Math.max(0, p.assessors - inServiceCount);
      let slotsToGrant = slotsAvailable;

      // Assign service slots to waiting dots (FIFO — earlier ids first)
      const waiting = s.dots
        .filter(d => d.stage === 1 && !d.inService && !d.moving)
        .sort((a, b) => a.id - b.id);
      for (const d of waiting) {
        if (slotsToGrant <= 0) break;
        d.inService = true;
        slotsToGrant--;
      }

      // ── Stage time limits ────────────────────────────────────────────────
      // Assessment time is per-assessor service time (not unlimited concurrency)
      const limits = [
        p.validationDays,
        p.daysPerApp,      // assessment — only counts when inService=true
        p.rfiDays,
        p.consentDays,
        p.decisionDays,
        8,                 // done — brief settle before falling off
      ];

      const newC = {};
      STAGES.forEach(st => { newC[st.id] = 0; });

      for (let i = s.dots.length - 1; i >= 0; i--) {
        const d = s.dots[i];

        // ── Physics ────────────────────────────────────────────────────────
        d.vy += GRAVITY * dt;
        d.vx *= FRICT;
        d.x  += d.vx * dt;
        d.y  += d.vy * dt;

        // Above canvas — free fall, no constraints
        if (d.y < 0) { newC[STAGES[d.stage].id]++; continue; }

        // Remove dots that have fallen off bottom after done
        if (d.falling && d.y > H + DOT_R * 4) {
          s._throughputTotal += d.totalDays;
          s._throughputCount++;
          s.completed++;
          s.dots.splice(i, 1); continue;
        }

        // Horizontal wall bounds always
        if (d.x < DOT_R)     { d.x = DOT_R;     d.vx =  Math.abs(d.vx) * 0.5; }
        if (d.x > W - DOT_R) { d.x = W - DOT_R; d.vx = -Math.abs(d.vx) * 0.5; }

        // ── Settled in zone ────────────────────────────────────────────────
        if (!d.moving && !d.falling) {
          const z     = Z[d.stage];
          const floor = z.y + z.h - DOT_R;
          const ceil  = z.y + DOT_R;

          if (d.y >= floor) {
            d.y  = floor;
            d.vy = -Math.abs(d.vy) * DAMPING;
            d.vx += (Math.random() - 0.5) * 8;
          }
          if (d.y < ceil) { d.y = ceil; d.vy = Math.abs(d.vy) * 0.3; }

          // Time only accrues when:
          // - not in assessment (stage 1), OR
          // - in assessment AND inService (has an assessor slot)
          // This is the core queuing constraint — waiting dots don't progress
          const canAccrue = d.stage !== 1 || d.inService;
          if (canAccrue) d.days += dtS;
          d.totalDays += dtS; // always accumulate total time

          // Transition when time served
          if (d.days >= limits[d.stage]) {
            d.days     = 0;
            d.moving   = true;
            d.inService = false;
            d.vx       = (Math.random() - 0.5) * 10;
            d.vy       = 5;

            if (d.stage === 1) {
              // rfiRate% get held in RFI, rest skip to consent
              d.target = (!d.hadRfi && Math.random() < p.rfiRate / 100) ? 2 : 3;
              if (d.target === 2) d.hadRfi = true;
            } else if (d.stage === 2) {
              d.target = 3;
            } else {
              d.target = Math.min(d.stage + 1, 5);
            }
          }
        }

        // ── Moving between zones ───────────────────────────────────────────
        if (d.moving) {
          const tz     = Z[d.target];
          const tFloor = tz.y + tz.h - DOT_R;
          const tCeil  = tz.y + DOT_R;

          // If flicked within same zone — enforce zone walls hard
          if (d.target === d.stage) {
            if (d.y >= tFloor) { d.y = tFloor; d.vy = -Math.abs(d.vy) * DAMPING; }
            if (d.y <= tCeil)  { d.y = tCeil;  d.vy =  Math.abs(d.vy) * DAMPING; }
            // Once velocity is low enough, settle
            if (Math.abs(d.vy) < 5 && Math.abs(d.vx) < 5) d.moving = false;
          } else {
            // Transitioning to a new zone — commit when reaching target floor
            if (d.y >= tz.y && d.y >= tFloor) {
              d.stage  = d.target;
              d.moving = false;
              d.y      = tFloor;
              d.vy     = -Math.abs(d.vy) * DAMPING;
            }
          }
        }

        // ── Done zone — settle then fall off ───────────────────────────────
        if (d.stage === 5 && !d.moving && !d.falling && d.days > 6) {
          d.falling = true;
          d.vy      = 40;
          d.vx      = (Math.random() - 0.5) * 15;
        }

        newC[STAGES[d.stage].id]++;
      }

      // ── Repulsion + hard separation ───────────────────────────────────────
      for (let i = 0; i < s.dots.length; i++) {
        for (let j = i + 1; j < s.dots.length; j++) {
          const a = s.dots[i], b = s.dots[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < SEP * SEP && d2 > 0.001) {
            const dist = Math.sqrt(d2), f = (SEP - dist) / dist * 280 * dt;
            a.vx -= dx * f; a.vy -= dy * f;
            b.vx += dx * f; b.vy += dy * f;
          }
        }
      }
      for (let it = 0; it < 2; it++) {
        for (let i = 0; i < s.dots.length; i++) {
          for (let j = i + 1; j < s.dots.length; j++) {
            const a = s.dots[i], b = s.dots[j];
            const dx = b.x - a.x, dy = b.y - a.y;
            const d2 = dx * dx + dy * dy, mn = DOT_R * 2 + 1;
            if (d2 < mn * mn && d2 > 0.001) {
              const dist = Math.sqrt(d2), push = (mn - dist) / 2;
              a.x -= dx / dist * push; a.y -= dy / dist * push;
              b.x += dx / dist * push; b.y += dy / dist * push;
            }
          }
        }
      }

      // Observed ρ: grows as backlog fills
      // = (all dots in assessment zone, waiting or in service) / assessors
      // Starts at 0, rises toward and beyond 100% as queue builds
      const inAssessment = s.dots.filter(d => d.stage === 1 && !d.moving).length;
      const observedRho  = p.assessors > 0 ? inAssessment / p.assessors : 0;
      // Smooth it slightly so it doesn't jump — exponential moving average
      s._lastRho = s._lastRho != null
        ? s._lastRho * 0.97 + observedRho * 0.03
        : observedRho;
      // Running estimate: blend completed average with live dots accruing time
      // Ticks up smoothly every frame rather than jumping on completion
      const liveTotalDays = s.dots.reduce((sum, d) => sum + d.totalDays, 0);
      const liveCount2    = s.dots.length;
      const totalDaysAll  = s._throughputTotal + liveTotalDays;
      const countAll      = s._throughputCount + liveCount2;
      const rawAvg        = countAll > 0 ? totalDaysAll / countAll : 0;
      s._smoothAvg        = s._smoothAvg != null ? s._smoothAvg * 0.995 + rawAvg * 0.005 : rawAvg;
      setCounters({ ...newC, _done: s.completed, _rho: s._lastRho, _elapsed: Math.floor(s._elapsedDays), _avgAssess: Math.round(s._smoothAvg || 0) });

      // ── Draw ──────────────────────────────────────────────────────────────
      ctx.clearRect(0, 0, W, H);

      // Zone dividers hidden

      const curRho = s._lastRho || 0;

      // Colour blend — gradual from stage colour through orange to red
      // No glow, no purple. 0–60% pure, 60–100% → orange, 100%+ → red
      const lrp = (a, b, t) => Math.round(a + (b-a) * Math.max(0, Math.min(1, t)));
      const blendHex = (c1, c2, t) => {
        const h = x => parseInt(x, 16);
        const [r1,g1,b1] = [h(c1.slice(1,3)),h(c1.slice(3,5)),h(c1.slice(5,7))];
        const [r2,g2,b2] = [h(c2.slice(1,3)),h(c2.slice(3,5)),h(c2.slice(5,7))];
        const x2 = n => n.toString(16).padStart(2,'0');
        return '#'+x2(lrp(r1,r2,t))+x2(lrp(g1,g2,t))+x2(lrp(b1,b2,t));
      };

      s.dots.forEach(d => {
        if (d.y < -DOT_R) return;
        const stageIdx = d.moving ? d.target : d.stage;
        const waiting  = d.stage === 1 && !d.inService && !d.moving;
        const baseCol  = C.stages[stageIdx];

        // Per-zone pressure based on wait time ratio:
        // A zone is under pressure when its current count exceeds its expected count
        // Expected = throughput rate × stage service time (Little's Law per stage)
        // λ = 1/interval, expected in zone i = λ × limits[i]
        const zoneIdx   = d.moving ? d.target : d.stage;
        const zoneCount = newC[STAGES[zoneIdx].id] || 0;

        // Assessment (zone 1): pressure = queue / assessors — anything over capacity is pressure
        // Other zones: pressure = count / expected (Little's Law: λ × service time)
        const lambda_  = 1 / Math.max(p.interval, 0.1);
        const expected = zoneIdx === 1
          ? Math.max(1, p.assessors)
          : Math.max(1, lambda_ * limits[zoneIdx]);
        const zonePressure = zoneCount / expected;

        let col = baseCol;
        if (zoneIdx !== 5) { // done zone never goes red
          if (zonePressure >= 1.2 && zonePressure < 2.5) {
            col = blendHex(baseCol, "#f07030", (zonePressure - 1.2) / 1.3);
          } else if (zonePressure >= 2.5) {
            col = blendHex("#f07030", "#e02020", Math.min((zonePressure - 2.5) / 1.5, 1));
          }
        }

        ctx.globalAlpha = waiting ? 0.4 : 1;
        ctx.beginPath();
        ctx.arc(d.x, d.y, DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 1;
      });

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, []);

  // ── Stats ────────────────────────────────────────────────────────────────
  // Little's Law: W = L / λ
  // λ = effective throughput rate (arrivals per sim-day)
  // L = avg number in system
  const live        = STAGES.reduce((a, st) => a + (counters[st.id] || 0), 0);
  const completed   = counters._done || 0;
  const elapsedDays = counters._elapsed || 0;
  const rhoDisplay  = Math.round((counters._rho || 0) * 100);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: C.bg, fontFamily: "'DM Sans','Helvetica Neue',sans-serif", overflow: "hidden" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", height: 46, flexShrink: 0, gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.text, whiteSpace: "nowrap" }}>Pipeline</span>

        <div style={{ display: "flex", alignItems: "center" }}>
          {[
            { v: live,                        l: "live"   },
            { v: completed,                   l: "done"   },
            { v: rhoDisplay + "%",            l: "cap"    },
            { v: (counters._avgAssess || 0) + "d", l: "avg"  },
          ].map(({ v, l }, i) => (
            <div key={l} style={{ display: "flex", alignItems: "baseline", gap: 2, whiteSpace: "nowrap", paddingLeft: i > 0 ? 10 : 0, marginLeft: i > 0 ? 10 : 0, borderLeft: i > 0 ? "1px solid " + C.border : "none" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{v}</span>
              <span style={{ fontSize: 8, color: C.muted }}>{l}</span>
            </div>
          ))}
        </div>

        <button onClick={() => setOpen(o => !o)}
          style={{ fontSize: 10, color: C.sub, background: open ? "#e0e0db" : "transparent", border: "1px solid " + C.border, borderRadius: 6, padding: "5px 10px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>
          {open ? "Close" : "Settings"}
        </button>
      </div>

      {/* ── Canvas + overlays ── */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}
        onPointerDown={e => {
          if (open) return;
          const el = e.currentTarget;
          const rect = el.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          let lastX = px, lastY = py, lastT = Date.now();
          let velX = 0, velY = 0;

          const onMove = ev => {
            const nx = ev.clientX - rect.left;
            const ny = ev.clientY - rect.top;
            const now = Date.now();
            const dt = Math.max(now - lastT, 1);
            velX = (nx - lastX) / dt * 1000;
            velY = (ny - lastY) / dt * 1000;
            lastX = nx; lastY = ny; lastT = now;

            // Push nearby dots while dragging
            const dots = stRef.current.dots;
            for (const d of dots) {
              const dx = d.x - nx, dy = d.y - ny;
              const dist = Math.sqrt(dx*dx + dy*dy);
              if (dist < 60) {
                const f = (60 - dist) / 60;
                d.vx += velX * f * 0.35;
                d.vy += velY * f * 0.35;
                d.moving = true;
                d.target = d.stage;
              }
            }
          };

          const onUp = ev => {
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerup", onUp);
            const nx = ev.clientX - rect.left;
            const ny = ev.clientY - rect.top;
            // If barely moved — spawn a dot
            const dx = nx - px, dy = ny - py;
            if (Math.sqrt(dx*dx + dy*dy) < 8) {
              stRef.current.dots.push(mkDot(nx, -DOT_R * 2));
            }
          };

          el.addEventListener("pointermove", onMove);
          el.addEventListener("pointerup", onUp);
        }}>

        <canvas ref={cvRef} style={{ width: "100%", height: "100%", display: "block" }} />

        {/* Stage labels top-left + counters top-right */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", display: "flex", flexDirection: "column" }}>
          {STAGES.map((st, i) => (
            <div key={st.id} style={{ flex: 1, display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "7px 12px 0" }}>
              <span style={{ fontSize: 8, color: C.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>{st.label}</span>
              <span style={{ fontSize: 10, fontWeight: 600, fontFamily: "monospace", color: (i === 5 ? completed : counters[st.id] || 0) > 0 ? C.stages[i] : C.dim }}>
                {i === 5 ? completed : (counters[st.id] || 0)}
              </span>
            </div>
          ))}
        </div>

        {/* Settings — slides in from right as overlay panel */}
        <div style={{
          position: "absolute", top: 0, right: 0, bottom: 0,
          width: "min(320px, 100%)",
          background: C.card,
          borderLeft: "1px solid " + C.border,
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.25s ease",
          overflowY: "auto",
          padding: "20px 20px",
          zIndex: 10,
          // Critical for mobile — panel has its own touch handling
          touchAction: "pan-y",
          pointerEvents: open ? "all" : "none",
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 6 }}>Settings</div>
          <div style={{ fontSize: 10, color: C.muted, marginBottom: 22 }}>Tap canvas to add applications.</div>

          <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Arrival rate</div>
          <Slider label="Days between arrivals" min={1}  max={30}  unit="d"  defaultVal={INIT.interval}       onChange={v => set("interval", v)} />

          <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12, marginTop: 18 }}>Capacity constraint</div>
          <Slider label="Number of assessors"   min={1}  max={40}  unit=""   defaultVal={INIT.assessors}      onChange={v => set("assessors", v)} />
          <Slider label="Days per assessment"   min={1}  max={180} unit="d"  defaultVal={INIT.daysPerApp}     onChange={v => set("daysPerApp", v)} />

          <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12, marginTop: 18 }}>Stages</div>
          <Slider label="Validation window"     min={0}  max={365} unit="d"  defaultVal={INIT.validationDays} onChange={v => set("validationDays", v)} />
          <Slider label="Consent time"          min={1}  max={120} unit="d"  defaultVal={INIT.consentDays}    onChange={v => set("consentDays", v)} />
          <Slider label="Decision time"         min={1}  max={120} unit="d"  defaultVal={INIT.decisionDays}   onChange={v => set("decisionDays", v)} />

          <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12, marginTop: 18 }}>Simulation</div>
          <Slider label="Speed" min={1} max={30} unit="x" defaultVal={INIT.speed} onChange={v => set("speed", v)} />

          <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12, marginTop: 18 }}>RFI</div>
          <Slider label="RFI rate"              min={0}  max={80}  unit="%"  defaultVal={INIT.rfiRate}        onChange={v => set("rfiRate", v)} />
          <Slider label="RFI response time"     min={0}  max={180} unit="d"  defaultVal={INIT.rfiDays}        onChange={v => set("rfiDays", v)} />

          <div style={{ marginTop: 24, paddingTop: 18, borderTop: "1px solid " + C.border }}>
            <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Key</div>
            {STAGES.map((st, i) => (
              <div key={st.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.stages[i], flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: C.sub }}>{st.label}</span>
              </div>
            ))}
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.stages[1], opacity: 0.4, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: C.muted }}>Waiting for assessor</span>
            </div>
          </div>

          <div style={{ marginTop: 20, padding: "12px", background: "#f4f4f0", borderRadius: 6 }}>
            <div style={{ fontSize: 9, color: C.muted, letterSpacing: "0.08em", marginBottom: 6 }}>QUEUING THEORY</div>
            <div style={{ fontSize: 10, color: C.sub, lineHeight: 1.6 }}>
              ρ (rolling) = {rhoDisplay}% utilisation<br />
              {rhoDisplay >= 100 ? "⚠ System saturated — backlog grows unbounded" :
               rhoDisplay >= 80  ? "System near capacity — expect growing queues" :
                                   "System stable — queue remains bounded"}
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ height: 28, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", flexShrink: 0 }}>
<span style={{ fontSize: 8, color: C.muted, letterSpacing: "0.07em" }}>1s = {params.speed} sim-days · {fmtDays(elapsedDays)} elapsed</span>
        <span style={{ fontSize: 8, color: C.muted }}>DPER 2026</span>
      </div>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 16px; background: transparent; outline: none; }
        input[type=range]::-webkit-slider-runnable-track { height: 1px; background: #c8c8c3; border-radius: 1px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #1c1c1a; margin-top: -6.5px; box-shadow: none; }
        input[type=range]::-moz-range-track { height: 1px; background: #c8c8c3; border-radius: 1px; }
        input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: #1c1c1a; border: none; box-shadow: none; }
      `}</style>
    </div>
  );
}
