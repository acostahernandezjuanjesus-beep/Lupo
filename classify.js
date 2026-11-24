// Proposes spend category, project and purchase type for an invoice, with a
// reason for each. When nothing supports a guess the value stays null:
// a blank gets fixed, a wrong-looking label gets trusted.
// Anything a person corrected is marked 'manual' in `classification` and never overwritten.

const norm = s => String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')     // strip accents
    .toUpperCase();

// First matching rule wins per line, so order matters: "TUBO INOXIDABLE" is raw
// material but "TUBULAR 71T-1" is welding wire, hence welding goes first.
// Keywords are Spanish because they match printed descriptions. They match as
// word prefixes (GUANTE hits GUANTES), never mid-word (BROCA misses EMBROCADO).
const RULES = [
    ['Industrial gases', ['GAS ', 'GAS,', 'OXIGENO', 'ARGON', 'ACETILENO', 'NITROGENO', 'CO2', 'MEZCLA 80', 'PROPANO', 'HELIO']],
    ['Welding consumables', ['MICROALAMBRE', 'ELECTRODO', 'TUBULAR', 'TOBERA', 'DIFUSOR', 'PUNTA DE CONTACTO', 'TUNGSTENO', 'FUNDENTE', 'ALAMBRE PARA SOLD', 'FIERRO VACIADO', 'VARILLA DE APORTE']],
    ['Abrasives and discs', ['DISCO', 'FIBRODISCO', 'LIJA', 'ABRASIV', 'PIEDRA DE ESMERIL', 'LAMINADO', 'BANDA DE LIJA']],
    ['Tools and equipment', ['BROCA', 'MACHUELO', 'TARRAJA', 'ENDMILL', 'FRESA', 'RIMA', 'BURIL', 'INSERTO', 'LLAVE ', 'TORQUIMETRO', 'MICROMETRO', 'CALIBRADOR', 'INVERSOR', 'SOLDADORA', 'ESMERILADORA', 'TALADRO', 'PINZA', 'MARTILLO', 'SIERRA', 'AVELLANADOR']],
    ['PPE and safety', ['GUANTE', 'CARETA', 'LENTE', 'CASCO', 'BOTA', 'TAPON AUDITIVO', 'OVEROL', 'MANDIL', 'RESPIRADOR', 'CHALECO', 'PETO']],
    ['Lubricants and chemicals', ['ACEITE', 'LUBRICANTE', 'GRASA', 'THINNER', 'SOLVENTE', 'PINTURA', 'ANTIADHERENTE', 'DESENGRASANTE', 'TALADRINA', 'REFRIGERANTE', 'PEGAMENTO', 'SILICON', 'CUBETA DE ACEITE']],
    ['Cleaning and hygiene', ['TRAPO', 'ESTOPA', 'JABON', 'ESCOBA', 'TRAPEADOR', 'PAPEL HIGIENICO', 'CLORO', 'DETERGENTE', 'LIMPIADOR', 'FRANELA']],
    ['Fasteners', ['TORNILLO', 'TUERCA', 'RONDANA', 'PERNO', 'TAQUETE', 'REMACHE', 'ESPARRAGO', 'CLAVO', 'BIRLO', 'ANCLA']],
    ['Raw material', ['ACERO', 'INOXIDABLE', 'ALUMINIO', 'NYLON', 'PLACA', 'BARRA', 'TUBO', 'PTR', 'PERFIL', 'LAMINA', 'ANGULO', 'SOLERA', 'REDONDO', 'BRONCE', 'COBRE', 'LATON', 'CANAL ', 'VIGA']],
    ['Services', ['SERVICIO', 'MANO DE OBRA', 'FLETE', 'MAQUILA', 'RENTA ', 'MANTENIMIENTO', 'CALIBRACION', 'TRANSPORTE', 'ASESORIA']],
];

// Fallback when keywords miss: first two digits of the SAT product/service
// key. Coarse, so it only runs after the keywords.
const SAT_SEGMENT = {
    '11': 'Raw material', '13': 'Raw material', '30': 'Raw material',
    '12': 'Lubricants and chemicals', '15': 'Lubricants and chemicals',
    '23': 'Tools and equipment', '27': 'Tools and equipment',
    '31': 'Fasteners', '46': 'PPE and safety', '47': 'Cleaning and hygiene',
    '72': 'Services', '73': 'Services', '76': 'Services', '78': 'Services', '80': 'Services', '81': 'Services',
};
// SAT class 1214 is gases; the rest of segment 12 is chemicals.
const isSatGas = key => /^1214/.test(key ?? '');

const STOCK_CATEGORIES = ['Industrial gases', 'Welding consumables', 'Abrasives and discs', 'Tools and equipment',
    'PPE and safety', 'Lubricants and chemicals', 'Cleaning and hygiene', 'Fasteners'];

function lineSpendCategory(l) {
    const text = ` ${norm(l.description)} `;
    for (const [category, words] of RULES) {
        for (const w of words) {
            // The leading space gives the prefix match; a trailing space in the keyword means whole word.
            if (text.includes(` ${w}`)) return { category, reason: `"${w.trim()}" in the description` };
        }
    }
    const key = String(l.prod_serv_key ?? '');
    if (isSatGas(key)) return { category: 'Industrial gases', reason: `SAT key ${key} (gases)` };
    const seg = SAT_SEGMENT[key.slice(0, 2)];
    return seg ? { category: seg, reason: `SAT key ${key} (segment ${key.slice(0, 2)})` } : null;
}

/** The category with the most amount across the invoice lines, or null value if no line matched. */
function invoiceSpendCategory(lines) {
    const weights = new Map(), reasons = new Map();
    for (const l of lines) {
        const r = lineSpendCategory(l);
        if (!r) continue;
        const weight = Number(l.amount ?? 0) || 1;
        weights.set(r.category, (weights.get(r.category) ?? 0) + weight);
        if (!reasons.has(r.category)) reasons.set(r.category, r.reason);
    }
    if (weights.size === 0) return { value: null, reason: 'No line could be classified: no spend category.' };
    const [category, weight] = [...weights].sort((a, b) => b[1] - a[1])[0];
    const total = [...weights.values()].reduce((a, b) => a + b, 0);
    const mix = weights.size > 1 ? ` (${Math.round(weight / total * 100)} % of the classified amount; ${weights.size - 1} more categor${weights.size - 1 === 1 ? 'y' : 'ies'})` : '';
    return { value: category, reason: `${reasons.get(category)}${mix}.` };
}

// ---- Project -----------------------------------------------------------

// Keys the supplier may have used in its own ids (Spanish: typed by users).
const PROJECT_KEYS = ['proyecto', 'obra', 'orden_trabajo', 'ot', 'orden_de_trabajo'];
const RE_PROJECT = /\b(OT|OP|OBRA|PROYECTO|PROY)[\s:#.-]*([A-Z]?\d{2,8}(?:-\d{1,4})?)\b/g;

const projectLabel = (kind, num) => `${kind === 'PROYECTO' ? 'PROY' : kind}-${num}`;

/** The project: what the supplier noted, or an "OT-2215" in the lines or the note. */
function invoiceProject({ lines = [], supplier_ids = {}, note = null }) {
    for (const k of PROJECT_KEYS) {
        const v = supplier_ids?.[k];
        if (typeof v === 'string' && v.trim()) return { value: norm(v.trim()).replace(/\s+/g, ''), reason: `noted by the supplier (${k}).` };
    }
    const found = new Map();
    for (const text of [...lines.map(l => l.description), note]) {
        for (const m of norm(text).matchAll(RE_PROJECT)) {
            const label = projectLabel(m[1], m[2]);
            found.set(label, (found.get(label) ?? 0) + 1);
        }
    }
    if (found.size === 0) return { value: null, reason: 'The invoice does not mention a project.' };
    if (found.size > 1) return { value: null, reason: `Mentions several projects (${[...found.keys()].join(', ')}): none picked.` };
    const [label, n] = [...found][0];
    return { value: label, reason: `"${label}" appears in ${n} line(s) or in the note.` };
}

// ---- Purchase type -----------------------------------------------------

/**
 * stock | direct_to_job | unclassified, with a reason. In order:
 *   1. Supplier history, if ALL its classified invoices agree (and there are at least 2).
 *   2. A named project + raw material: bought against a job, not for stock.
 *   3. A consumables category (gases, discs, PPE...): stock.
 *   4. Otherwise unclassified.
 * `history` is { stock: n, direct_to_job: n } from earlier invoices of the same issuer.
 */
function purchaseTypeOf({ spend_category, project, history = {} }) {
    const n = { stock: history.stock ?? 0, direct_to_job: history.direct_to_job ?? 0 };
    const total = n.stock + n.direct_to_job;
    if (total >= 2 && (n.stock === 0 || n.direct_to_job === 0)) {
        const type = n.stock > 0 ? 'stock' : 'direct_to_job';
        return { value: type, reason: `The ${total} previous invoices from this supplier were classified as ${type === 'stock' ? 'stock' : 'direct to job'}.` };
    }
    if (project && spend_category === 'Raw material') {
        return { value: 'direct_to_job', reason: `Raw material for ${project}: bought against a job, not for stock.` };
    }
    if (spend_category && STOCK_CATEGORIES.includes(spend_category)) {
        return { value: 'stock', reason: `${spend_category} is material kept in the warehouse.` };
    }
    return { value: 'unclassified', reason: 'Not enough history or signals: a person decides.' };
}

/** Full classification. `current` is what the invoice already has, so manual fixes survive. */
function classifyInvoice({ lines = [], supplier_ids = {}, note = null, history = {}, current = {} }) {
    const decide = (field, computed) => {
        if (current?.[field]?.source === 'manual') return current[field];
        return { value: computed.value, source: 'auto', reason: computed.reason };
    };
    const spend_category = decide('spend_category', invoiceSpendCategory(lines));
    const project = decide('project', invoiceProject({ lines, supplier_ids, note }));
    const purchase_type = decide('purchase_type', purchaseTypeOf({ spend_category: spend_category.value, project: project.value, history }));
    return { spend_category, project, purchase_type };
}

module.exports = { classifyInvoice, invoiceSpendCategory, invoiceProject, purchaseTypeOf, SPEND_CATEGORIES: RULES.map(r => r[0]) };
