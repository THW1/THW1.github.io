// === CONTEXT ===
// Purpose:     Visualise any German consumer or property loan over time: how much of the money
//              paid accumulates as pure interest cost vs. how much reduces the debt (Tilgung),
//              with optional Sondertilgungen. Covers Baufinanzierung down to revolving credit
//              card debt, so the cost difference between loan types is visible in one tool.
//              Companion to the ETF-savings visualiser (same project, opposite sign).
// Decisions:   - Simulation is monthly throughout and rows are stored per month; display rows are
//                aggregated to years only when the term exceeds 72 months. Storing yearly rows
//                (v1) made short loans unplottable — a 12-month loan had one data point.
//              - Three repayment modes, because the loan types genuinely differ:
//                  tilgung  — Annuität = Darlehen × (Zins + anfängl. Tilgung), German mortgage convention
//                  laufzeit — standard annuity solved for a fixed term, how car/instalment loans are sold
//                  mindest  — rate = max(x % of balance, floor), how revolving cards actually work
//                Modelling a card as an annuity was rejected: the declining payment is exactly
//                what makes minimum-payment debt dangerous, so flattening it hides the point.
//              - Laufzeit and Tilgungssatz are redundant given Darlehen + Zins. The mode switch
//                makes the driving parameter explicit rather than silently picking one.
//              - Presets only seed defaults and slider ranges; every value stays freely editable.
//                Rejected: locking ranges per product — users legitimately want to explore edges.
//              - Sondertilgung is booked at the end of the chosen month; "jährlich" repeats every
//                12 months from there, matching the usual "x % p.a. of the original loan" clause.
// Constraints: Recharts + Tailwind core utilities only (no arbitrary values, no compiler).
//              No browser storage APIs — state is in-memory only.
// Invariants:  Sum of all Tilgung (incl. Sondertilgung) always equals the loan amount; the
//              "Gesamtzahlung" KPI relies on this identity instead of re-summing rows.
//              MAX_MONATE caps the loop so a non-amortising configuration cannot hang the UI —
//              hitting the cap is a real result for minimum-payment debt and is surfaced, not hidden.
// Limitations: Nominal Sollzins only — no Effektivzins, no Bearbeitungs-/Kontogebühren, no
//              Kaufnebenkosten, no Schlussrate/Ballonrate (Drei-Wege-Finanzierung), no Zinsbindung
//              or Anschlussfinanzierung, no tilgungsfreie Anlaufjahre, no inflation, no tax effects.
//              Dispo interest accrues on the daily balance in reality; here it is monthly.
// === END CONTEXT ===

import React, { useState, useMemo } from "react";
import {
  ComposedChart, Area, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";
const SANS = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const MAX_MONATE = 600;

const C = {
  bg: "#EDEFEA", surface: "#FFFFFF", ink: "#171B1F", muted: "#6C767C", line: "#D6DAD3",
  zins: "#A6402B", tilgung: "#1E4E5F", sonder: "#C3892A", rest: "#8A9499",
};

const PRESETS = {
  bau: {
    name: "Baufinanzierung", labelBetrag: "Kaufpreis", labelAnzahlung: "Eigenkapital", einheit: "jahre",
    r: { betrag: [50000, 1500000, 10000], zins: [0.5, 12, 0.1], tilgung: [0.5, 15, 0.1], laufzeitM: [60, 480, 12] },
    d: { betrag: 450000, anzahlung: 90000, zins: 3.6, tilgung: 2.5, laufzeitM: 300, modus: "tilgung" },
    note: "Ein fester Sollzins über die gesamte Laufzeit. Zinsbindung und Anschlussfinanzierung sind nicht abgebildet.",
  },
  auto: {
    name: "Autokredit", labelBetrag: "Fahrzeugpreis", labelAnzahlung: "Anzahlung", einheit: "monate",
    r: { betrag: [2000, 150000, 500], zins: [0, 15, 0.1], tilgung: [2, 100, 0.5], laufzeitM: [12, 96, 6] },
    d: { betrag: 32000, anzahlung: 5000, zins: 5.9, tilgung: 25, laufzeitM: 48, modus: "laufzeit" },
    note: "Marktdurchschnitt Mitte 2026 rund 5,9 % eff. p. a., Spanne je nach Bonität etwa 3,3 bis 12 %. Eine Schlussrate (Ballonfinanzierung) ist nicht abgebildet.",
  },
  raten: {
    name: "Ratenkredit", labelBetrag: "Kreditbetrag", labelAnzahlung: "Eigenanteil", einheit: "monate",
    r: { betrag: [500, 100000, 500], zins: [0, 20, 0.1], tilgung: [2, 150, 0.5], laufzeitM: [6, 120, 6] },
    d: { betrag: 10000, anzahlung: 0, zins: 6.9, tilgung: 30, laufzeitM: 48, modus: "laufzeit" },
    note: "Bundesbank-Neugeschäft Juni 2026: rund 6,9 % bei ein bis fünf Jahren Zinsbindung, 8,7 % darüber.",
  },
  karte: {
    name: "Kreditkarte / Dispo", labelBetrag: "Offener Saldo", labelAnzahlung: "Sofort beglichen", einheit: "monate",
    r: { betrag: [200, 30000, 100], zins: [5, 30, 0.1], tilgung: [1, 60, 0.5], laufzeitM: [6, 240, 6] },
    d: { betrag: 4000, anzahlung: 0, zins: 18, tilgung: 12, laufzeitM: 60, modus: "mindest" },
    note: "Kreditkarten-Teilzahlung liegt bei 13 bis 25 % p. a. (Marktschnitt etwa 17 %), der Dispo im Mittel bei rund 11 %. Die Mindestrate beträgt meist 3 % des Saldos oder 25 bis 50 €.",
  },
};

const eur = (v) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v || 0);
const eurK = (v) => (Math.abs(v) >= 1000 ? Math.round(v / 1000) + "k" : Math.round(v || 0)) + " €";
const pct = (v) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(v || 0) + " %";
const dauer = (m) => (m >= 24 ? Math.floor(m / 12) + " J. " + (m % 12) + " Mon." : m + " Monate");

function sonderBetrag(liste, monat, faktor) {
  return liste.reduce((s, e) => {
    const start = Math.max(Math.round((Number(e.zeit) || 0) * faktor), 1);
    const trifft = e.jaehrlich ? monat >= start && (monat - start) % 12 === 0 : monat === start;
    return trifft ? s + (Number(e.betrag) || 0) : s;
  }, 0);
}

// rateFn(restschuld) -> monthly payment. Constant for annuity loans, balance-dependent for revolving debt.
function simulate(darlehen, zinsPa, rateFn, sonder, faktor) {
  const i = zinsPa / 100 / 12;
  const rows = [{ m: 0, zins: 0, tilgung: 0, sonder: 0, kumZins: 0, kumTilgung: 0, rest: darlehen }];
  let rest = darlehen, kumZins = 0, kumTilg = 0, m = 0, amortisiert = true;

  while (rest > 0.005 && m < MAX_MONATE) {
    m++;
    const z = rest * i;
    let t = rateFn(rest) - z;
    if (t <= 0.005) { amortisiert = false; break; }   // rate does not even cover the interest
    if (t > rest) t = rest;
    rest -= t;
    kumZins += z; kumTilg += t;

    let st = 0;
    if (rest > 0.005) {
      st = Math.min(sonderBetrag(sonder, m, faktor), rest);
      if (st > 0) { rest -= st; kumTilg += st; }
    }
    rows.push({ m, zins: z, tilgung: t, sonder: st, kumZins, kumTilgung: kumTilg, rest: Math.max(rest, 0) });
  }
  return { rows, monate: m, gesamtZins: kumZins, amortisiert, gekappt: m >= MAX_MONATE && rest > 0.005 };
}

function aggregate(rows, gran) {
  if (gran === 1) return rows;
  const out = [rows[0]];
  let zins = 0, tilgung = 0, sonder = 0;
  for (let k = 1; k < rows.length; k++) {
    zins += rows[k].zins; tilgung += rows[k].tilgung; sonder += rows[k].sonder;
    if (k % gran === 0 || k === rows.length - 1) {
      out.push({ ...rows[k], zins, tilgung, sonder });
      zins = 0; tilgung = 0; sonder = 0;
    }
  }
  return out;
}

function Slider({ label, value, set, min, max, step, format, farbe }) {
  return (
    <div className="mb-5">
      <div className="flex items-baseline justify-between mb-1 gap-3">
        <span className="text-sm" style={{ color: C.muted }}>{label}</span>
        <span className="text-base font-semibold" style={{ color: C.ink, fontVariantNumeric: "tabular-nums" }}>
          {format(value)}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => set(Number(e.target.value))}
        className="w-full cursor-pointer" style={{ accentColor: farbe || C.tilgung }} />
    </div>
  );
}

function Kennzahl({ label, wert, hinweis, farbe }) {
  return (
    <div className="px-5 py-3 flex-1" style={{ minWidth: 150 }}>
      <div className="text-xs mb-1" style={{ color: C.muted }}>{label}</div>
      <div className="text-xl" style={{ color: farbe || C.ink, fontFamily: SERIF, fontVariantNumeric: "tabular-nums" }}>{wert}</div>
      {hinweis && <div className="text-xs mt-1" style={{ color: C.muted }}>{hinweis}</div>}
    </div>
  );
}

function TooltipBox({ active, payload, label, einheitJahre, suffix }) {
  if (!active || !payload) return null;
  const zeilen = payload.filter((x) => x.value > 0.5);
  if (!zeilen.length) return null;
  const zeit = einheitJahre ? "Jahr " + Math.round(label / 12) : "Monat " + Math.round(label);
  return (
    <div className="px-3 py-2 text-xs shadow-sm" style={{ background: C.surface, border: "1px solid " + C.line, fontFamily: SANS }}>
      <div className="mb-1" style={{ color: C.muted }}>{zeit} {suffix}</div>
      {zeilen.map((x) => (
        <div key={x.dataKey} className="flex justify-between gap-4" style={{ color: C.ink }}>
          <span style={{ color: x.color }}>{x.name}</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{eur(x.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function KreditVisualisierung() {
  const [presetKey, setPresetKey] = useState("bau");
  const p = PRESETS[presetKey];

  const [betrag, setBetrag] = useState(PRESETS.bau.d.betrag);
  const [anzahlung, setAnzahlung] = useState(PRESETS.bau.d.anzahlung);
  const [zins, setZins] = useState(PRESETS.bau.d.zins);
  const [modus, setModus] = useState(PRESETS.bau.d.modus);
  const [tilgung, setTilgung] = useState(PRESETS.bau.d.tilgung);
  const [laufzeitM, setLaufzeitM] = useState(PRESETS.bau.d.laufzeitM);
  const [mindestProzent, setMindestProzent] = useState(3);
  const [mindestBetrag, setMindestBetrag] = useState(30);
  const [sonder, setSonder] = useState([]);
  const [sonderAn, setSonderAn] = useState(true);

  const jahreEinheit = p.einheit === "jahre";
  const faktor = jahreEinheit ? 12 : 1;
  const darlehen = Math.max(betrag - anzahlung, 0);

  const wechsel = (k) => {
    const n = PRESETS[k];
    setPresetKey(k);
    setBetrag(n.d.betrag); setAnzahlung(n.d.anzahlung); setZins(n.d.zins);
    setModus(n.d.modus); setTilgung(n.d.tilgung); setLaufzeitM(n.d.laufzeitM);
    setSonder([]);
  };
  const setBetragClamped = (v) => { setBetrag(v); if (anzahlung > v) setAnzahlung(v); };

  const aktiveSonder = useMemo(() => (sonderAn ? sonder : []), [sonderAn, sonder]);

  const rateFn = useMemo(() => {
    if (darlehen <= 0) return () => 0;
    const i = zins / 100 / 12;
    if (modus === "tilgung") {
      const r = (darlehen * (zins + tilgung)) / 100 / 12;
      return () => r;
    }
    if (modus === "laufzeit") {
      const r = i > 0 ? (darlehen * i) / (1 - Math.pow(1 + i, -laufzeitM)) : darlehen / laufzeitM;
      return () => r;
    }
    return (rest) => Math.max((rest * mindestProzent) / 100, mindestBetrag);
  }, [darlehen, zins, tilgung, laufzeitM, modus, mindestProzent, mindestBetrag]);

  const mit = useMemo(() => simulate(darlehen, zins, rateFn, aktiveSonder, faktor), [darlehen, zins, rateFn, aktiveSonder, faktor]);
  const ohne = useMemo(() => simulate(darlehen, zins, rateFn, [], faktor), [darlehen, zins, rateFn, faktor]);

  const gran = mit.monate > 72 ? 12 : 1;
  const daten = useMemo(() => aggregate(mit.rows, gran), [mit, gran]);

  const startRate = rateFn(darlehen);
  const gesamtZahlung = mit.gesamtZins + darlehen;
  const zinsAnteil = gesamtZahlung > 0 ? (mit.gesamtZins / gesamtZahlung) * 100 : 0;
  const ersparnisZins = ohne.gesamtZins - mit.gesamtZins;
  const ersparnisMonate = ohne.monate - mit.monate;
  const abgeleitet =
    modus === "tilgung" ? "Laufzeit ergibt sich"
      : modus === "laufzeit" ? "anfängl. Tilgung " + pct(darlehen > 0 ? ((startRate * 12 - (darlehen * zins) / 100) / darlehen) * 100 : 0)
        : "sinkt mit dem Saldo";

  const addSonder = () =>
    setSonder((s) => [...s, { id: Date.now(), zeit: jahreEinheit ? 5 : 12, betrag: Math.max(Math.round(darlehen * 0.05), 100), jaehrlich: false }]);
  const updSonder = (id, feld, wert) => setSonder((s) => s.map((e) => (e.id === id ? { ...e, [feld]: wert } : e)));
  const delSonder = (id) => setSonder((s) => s.filter((e) => e.id !== id));

  const problem = darlehen <= 0
    ? "Der Eigenanteil deckt den Betrag — es wird kein Kredit benötigt."
    : !mit.amortisiert
      ? "Die Rate deckt nicht einmal die Zinsen. Die Schuld wächst. Rate, Tilgung oder Eigenanteil erhöhen."
      : null;

  return (
    <div className="min-h-screen p-5 md:p-8" style={{ background: C.bg, fontFamily: SANS, color: C.ink }}>
      <div className="mx-auto" style={{ maxWidth: 1120 }}>

        <h1 className="text-2xl md:text-3xl mb-1" style={{ fontFamily: SERIF }}>Was der Kredit wirklich kostet</h1>
        <p className="text-sm mb-5" style={{ color: C.muted }}>
          Von der Baufinanzierung bis zur Kreditkarten-Teilzahlung — dieselbe Rechnung, sehr verschiedene Ergebnisse.
        </p>

        <div className="flex flex-wrap mb-6" style={{ border: "1px solid " + C.line, background: C.surface }}>
          {Object.entries(PRESETS).map(([k, v]) => (
            <button key={k} onClick={() => wechsel(k)} className="px-4 py-2 text-sm"
              style={{ background: presetKey === k ? C.ink : "transparent", color: presetKey === k ? C.surface : C.muted }}>
              {v.name}
            </button>
          ))}
        </div>

        <div className="p-5 md:p-6 mb-6" style={{ background: C.surface, border: "1px solid " + C.line }}>
          {problem ? (
            <p className="text-sm" style={{ color: darlehen <= 0 ? C.muted : C.zins }}>{problem}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-x-10 gap-y-3 mb-5">
                <div>
                  <div className="text-xs mb-1" style={{ color: C.muted }}>
                    {mit.gekappt ? "In 50 Jahren gezahlt — und immer noch nicht getilgt" : "Gesamtzahlung über " + dauer(mit.monate)}
                  </div>
                  <div style={{ fontFamily: SERIF, fontSize: 40, lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }}>
                    {eur(gesamtZahlung)}
                  </div>
                </div>
                <div>
                  <div className="text-xs mb-1" style={{ color: C.muted }}>davon reine Zinskosten</div>
                  <div style={{ fontFamily: SERIF, fontSize: 40, lineHeight: 1.05, color: C.zins, fontVariantNumeric: "tabular-nums" }}>
                    {eur(mit.gesamtZins)}
                  </div>
                </div>
              </div>

              <div className="flex h-3 w-full mb-2">
                <div style={{ width: 100 - zinsAnteil + "%", background: C.tilgung }} />
                <div style={{ width: zinsAnteil + "%", background: C.zins }} />
              </div>
              <div className="flex justify-between text-xs" style={{ color: C.muted }}>
                <span>Tilgung {pct(100 - zinsAnteil)}</span>
                <span style={{ color: C.zins }}>Zinsen {pct(zinsAnteil)} — an die Bank</span>
              </div>

              {mit.gekappt && (
                <p className="text-sm mt-4 pt-4" style={{ color: C.zins, borderTop: "1px solid " + C.line }}>
                  Mit dieser Rate ist die Schuld nach 50 Jahren nicht abbezahlt. Bei revolvierenden Krediten ist das
                  der Normalfall: die Mindestrate sinkt mit dem Saldo genau so schnell, wie der Saldo fällt.
                </p>
              )}
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          <div className="p-5" style={{ background: C.surface, border: "1px solid " + C.line }}>
            <Slider label={p.labelBetrag} value={betrag} set={setBetragClamped}
              min={p.r.betrag[0]} max={p.r.betrag[1]} step={p.r.betrag[2]} format={eur} />
            <Slider label={p.labelAnzahlung} value={anzahlung} set={setAnzahlung}
              min={0} max={p.r.betrag[1]} step={p.r.betrag[2]} format={eur} />
            <Slider label="Sollzins p. a." value={zins} set={setZins}
              min={p.r.zins[0]} max={p.r.zins[1]} step={p.r.zins[2]} format={pct} farbe={C.zins} />

            <div className="flex mt-6 mb-4" style={{ border: "1px solid " + C.line }}>
              {[["tilgung", "Tilgung"], ["laufzeit", "Laufzeit"], ["mindest", "Mindestrate"]].map(([k, t]) => (
                <button key={k} onClick={() => setModus(k)} className="flex-1 py-2 text-xs"
                  style={{ background: modus === k ? C.ink : "transparent", color: modus === k ? C.surface : C.muted }}>
                  {t}
                </button>
              ))}
            </div>

            {modus === "tilgung" && (
              <Slider label="anfängliche Tilgung p. a." value={tilgung} set={setTilgung}
                min={p.r.tilgung[0]} max={p.r.tilgung[1]} step={p.r.tilgung[2]} format={pct} />
            )}
            {modus === "laufzeit" && (
              <Slider label="Laufzeit" value={laufzeitM} set={setLaufzeitM}
                min={p.r.laufzeitM[0]} max={p.r.laufzeitM[1]} step={p.r.laufzeitM[2]}
                format={(v) => (jahreEinheit ? Math.round(v / 12) + " Jahre" : v + " Monate")} />
            )}
            {modus === "mindest" && (
              <>
                <Slider label="Mindestrate vom Saldo" value={mindestProzent} set={setMindestProzent}
                  min={1} max={10} step={0.5} format={pct} farbe={C.sonder} />
                <Slider label="mindestens aber" value={mindestBetrag} set={setMindestBetrag}
                  min={0} max={200} step={5} format={eur} farbe={C.sonder} />
              </>
            )}

            <div className="pt-4 mt-2" style={{ borderTop: "1px solid " + C.line }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm" style={{ color: C.muted }}>Sondertilgungen</span>
                <button onClick={() => setSonderAn((v) => !v)} className="text-xs px-2 py-1"
                  style={{ border: "1px solid " + C.line, color: sonderAn ? C.ink : C.muted, background: sonderAn ? C.bg : "transparent" }}>
                  {sonderAn ? "aktiv" : "aus"}
                </button>
              </div>

              {sonder.map((e) => (
                <div key={e.id} className="flex items-center gap-2 mb-2 text-xs">
                  <span style={{ color: C.muted }}>{jahreEinheit ? "Jahr" : "Monat"}</span>
                  <input type="number" min={1} value={e.zeit} onChange={(ev) => updSonder(e.id, "zeit", Number(ev.target.value))}
                    className="w-12 px-1 py-1" style={{ border: "1px solid " + C.line, fontVariantNumeric: "tabular-nums" }} />
                  <input type="number" min={0} step={100} value={e.betrag} onChange={(ev) => updSonder(e.id, "betrag", Number(ev.target.value))}
                    className="w-24 px-1 py-1" style={{ border: "1px solid " + C.line, fontVariantNumeric: "tabular-nums" }} />
                  <label className="flex items-center gap-1 cursor-pointer" style={{ color: C.muted }}>
                    <input type="checkbox" checked={e.jaehrlich} style={{ accentColor: C.sonder }}
                      onChange={(ev) => updSonder(e.id, "jaehrlich", ev.target.checked)} />
                    jährlich
                  </label>
                  <button onClick={() => delSonder(e.id)} className="ml-auto px-1" style={{ color: C.muted }}>✕</button>
                </div>
              ))}

              <button onClick={addSonder} className="text-xs mt-2 px-2 py-1" style={{ border: "1px solid " + C.line, color: C.ink }}>
                Sondertilgung hinzufügen
              </button>

              {sonderAn && ersparnisZins > 1 && (
                <p className="text-xs mt-4" style={{ color: C.tilgung }}>
                  Spart {eur(ersparnisZins)} Zinsen und verkürzt die Rückzahlung um {dauer(ersparnisMonate)}.
                </p>
              )}
            </div>
          </div>

          <div className="lg:col-span-2">

            <div className="flex flex-wrap" style={{ background: C.surface, border: "1px solid " + C.line }}>
              <Kennzahl label="Kreditsumme" wert={eur(darlehen)}
                hinweis={betrag > 0 ? pct((anzahlung / betrag) * 100) + " aus eigener Tasche" : null} />
              <Kennzahl label={modus === "mindest" ? "Erste Rate" : "Monatliche Rate"} wert={eur(startRate)} hinweis={abgeleitet} />
              <Kennzahl label="Rückzahlungsdauer" wert={mit.gekappt ? "über 50 Jahre" : dauer(mit.monate)} />
              <Kennzahl label="Zinskosten" wert={eur(mit.gesamtZins)} farbe={C.zins} hinweis={pct(zinsAnteil) + " der Zahlungen"} />
            </div>

            <div className="p-5 mt-6" style={{ background: C.surface, border: "1px solid " + C.line }}>
              <h2 className="text-base mb-1" style={{ fontFamily: SERIF }}>Kumuliert gezahlt, und was noch offen ist</h2>
              <p className="text-xs mb-4" style={{ color: C.muted }}>
                Die Fläche ist alles, was bis dahin abgeflossen ist. Die gestrichelte Linie ist die Restschuld.
              </p>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={daten} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid stroke={C.line} vertical={false} />
                  <XAxis dataKey="m" type="number" domain={[0, "dataMax"]} stroke={C.line}
                    tick={{ fontSize: 11, fill: C.muted }}
                    tickFormatter={(v) => (gran === 12 ? Math.round(v / 12) : Math.round(v))} />
                  <YAxis tick={{ fontSize: 11, fill: C.muted }} stroke={C.line} tickFormatter={eurK} width={58} />
                  <Tooltip content={<TooltipBox einheitJahre={gran === 12} suffix="— kumuliert" />} />
                  <Area type="monotone" dataKey="kumTilgung" stackId="a" name="Tilgung" stroke={C.tilgung} fill={C.tilgung} fillOpacity={0.85} />
                  <Area type="monotone" dataKey="kumZins" stackId="a" name="Zinsen" stroke={C.zins} fill={C.zins} fillOpacity={0.85} />
                  <Line type="monotone" dataKey="rest" name="Restschuld" stroke={C.rest} strokeWidth={2} strokeDasharray="4 3" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <p className="text-xs mt-2" style={{ color: C.muted }}>{gran === 12 ? "Jahre" : "Monate"}</p>
            </div>

            <div className="p-5 mt-6" style={{ background: C.surface, border: "1px solid " + C.line }}>
              <h2 className="text-base mb-1" style={{ fontFamily: SERIF }}>Jede Rate, aufgeteilt</h2>
              <p className="text-xs mb-4" style={{ color: C.muted }}>
                {modus === "mindest"
                  ? "Die Rate schrumpft mit dem Saldo — deshalb bleibt der Zinsanteil hartnäckig hoch."
                  : "Die Rate bleibt gleich, der Zinsanteil schrumpft. Am Anfang zahlt man fast nur Zinsen."}
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={daten.filter((r) => r.m > 0)} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                  <CartesianGrid stroke={C.line} vertical={false} />
                  <XAxis dataKey="m" stroke={C.line} tick={{ fontSize: 11, fill: C.muted }}
                    tickFormatter={(v) => (gran === 12 ? Math.round(v / 12) : Math.round(v))} />
                  <YAxis tick={{ fontSize: 11, fill: C.muted }} stroke={C.line} tickFormatter={eurK} width={58} />
                  <Tooltip cursor={{ fill: C.bg }}
                    content={<TooltipBox einheitJahre={gran === 12} suffix={gran === 12 ? "— in diesem Jahr" : "— in diesem Monat"} />} />
                  <Bar dataKey="zins" stackId="b" name="Zinsen" fill={C.zins} />
                  <Bar dataKey="tilgung" stackId="b" name="Tilgung" fill={C.tilgung} />
                  <Bar dataKey="sonder" stackId="b" name="Sondertilgung" fill={C.sonder} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <p className="text-xs mt-4" style={{ color: C.muted }}>
              {p.note} Gerechnet wird mit dem nominalen Sollzins und monatlicher Verzinsung, ohne Gebühren,
              Kaufnebenkosten, Schlussrate oder Steuereffekte. Der Effektivzins liegt entsprechend höher.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
