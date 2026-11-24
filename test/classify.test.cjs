const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyInvoice, invoiceSpendCategory, invoiceProject, purchaseTypeOf } = require('../classify');
const { readXml } = require('../cfdi');

const L = (description, amount = '100', prod_serv_key = null) => ({ description, amount, prod_serv_key });
const sample = n => readXml(fs.readFileSync(path.join(__dirname, 'samples', n + '.xml'), 'utf8')).invoice;

test('spend category: by the words of the line, with its reason', () => {
    const cases = [
        ['RECARGA DE GAS OXIGENO INDUSTRIAL 9.5 M3', 'Industrial gases'], ['MICROALAMBRE ER70S-6 0.035 CARRETE', 'Welding consumables'],
        ['DISCO DE CORTE 7" X 1/16"', 'Abrasives and discs'], ['BROCA HSS 1/2"', 'Tools and equipment'], ['GUANTES DE CARNAZA', 'PPE and safety'],
        ['CUBETA DE ACEITE SOLUBLE', 'Lubricants and chemicals'], ['TRAPO KILOGRAMO', 'Cleaning and hygiene'], ['TAQUETE DE PLASTICO 1/4"', 'Fasteners'],
        ['TUBO INOXIDABLE 304 2 1/2"', 'Raw material'], ['REDONDO DE NYLON 3"', 'Raw material'], ['SERVICIO DE MAQUILA', 'Services'],
    ];
    for (const [d, expected] of cases) {
        const r = invoiceSpendCategory([L(d)]);
        assert.equal(r.value, expected, d); assert.match(r.reason, /in the description/);
    }
});
test('spend category: rule order matters ("TUBULAR" is welding, "TUBO" is raw material)', () => {
    assert.equal(invoiceSpendCategory([L('TUBULAR 71T-1 0.045')]).value, 'Welding consumables');
    assert.equal(invoiceSpendCategory([L('TUBO PARA ANDAMIO')]).value, 'Raw material');
});
test('spend category: by word, not by piece ("AGUANTE" is not a glove, "GASOLINA" is not gas)', () => {
    assert.equal(invoiceSpendCategory([L('AGUANTE DE PRUEBA')]).value, null);
    assert.equal(invoiceSpendCategory([L('GASOLINA MAGNA')]).value, null);
});
test('spend category: what is not recognised stays null, never guessed; the SAT key is the fallback', () => {
    const empty = invoiceSpendCategory([L('ARTICULO MISTERIOSO 77')]);
    assert.equal(empty.value, null); assert.match(empty.reason, /no spend category/);
    const sat = invoiceSpendCategory([L('ARTICULO MISTERIOSO', '100', '47131800')]);
    assert.equal(sat.value, 'Cleaning and hygiene'); assert.match(sat.reason, /SAT key 47131800/);
    assert.equal(invoiceSpendCategory([L('COSA', '100', '12141500')]).value, 'Industrial gases');
});
test('spend category: with several, the one with the most amount wins', () => {
    const r = invoiceSpendCategory([L('DISCO DE CORTE', '100'), L('TUBO INOXIDABLE', '900')]);
    assert.equal(r.value, 'Raw material'); assert.match(r.reason, /90 %/);
});
test('project: from what the supplier noted, or from "OT-2215" in the lines', () => {
    assert.equal(invoiceProject({ supplier_ids: { orden_trabajo: 'ot 2215' } }).value, 'OT2215');
    const p = invoiceProject({ lines: [L('TUBO INOX PARA OT-2215'), L('BARRA OT 2215')] });
    assert.equal(p.value, 'OT-2215'); assert.match(p.reason, /2 line/);
    assert.equal(invoiceProject({ note: 'Para la obra 14' }).value, 'OBRA-14');
});
test('project: no mention, or several different ones, is null: none is picked', () => {
    assert.equal(invoiceProject({ lines: [L('DISCO DE CORTE')] }).value, null);
    const v = invoiceProject({ lines: [L('TUBO OT-100'), L('BARRA OT-200')] });
    assert.equal(v.value, null); assert.match(v.reason, /several projects/);
});
test('purchase type: supplier history > raw material with project > stock category > unclassified', () => {
    assert.equal(purchaseTypeOf({ spend_category: null, project: null, history: { stock: 3 } }).value, 'stock');
    assert.equal(purchaseTypeOf({ spend_category: 'Industrial gases', project: null, history: { direct_to_job: 2 } }).value, 'direct_to_job', 'history beats the category');
    assert.equal(purchaseTypeOf({ spend_category: 'Raw material', project: 'OT-1' }).value, 'direct_to_job');
    assert.equal(purchaseTypeOf({ spend_category: 'Raw material', project: null }).value, 'unclassified', 'raw material without a project is not guessed');
    assert.equal(purchaseTypeOf({ spend_category: 'PPE and safety', project: null }).value, 'stock');
    assert.equal(purchaseTypeOf({ spend_category: null, project: null, history: { stock: 1 } }).value, 'unclassified', 'a single invoice is not a history');
    assert.equal(purchaseTypeOf({ spend_category: 'Raw material', project: null, history: { stock: 2, direct_to_job: 1 } }).value, 'unclassified', 'a split history does not decide');
});
test('what a person corrected by hand is not touched again', () => {
    const current = { spend_category: { value: 'Services', source: 'manual', reason: 'corrected by a person' } };
    const r = classifyInvoice({ lines: [L('DISCO DE CORTE')], current });
    assert.equal(r.spend_category.value, 'Services'); assert.equal(r.spend_category.source, 'manual');
    assert.equal(r.purchase_type.source, 'auto');
});
test('the sample invoices: steel is raw material for OT-2215 direct to job; consumables are stock; gases are stock', () => {
    const c = f => classifyInvoice({ lines: f.lines.map(k => ({ description: k.description, amount: k.amount, prod_serv_key: k.prod_serv_key })) });
    const a = c(sample('f1-steel'));
    assert.equal(a.spend_category.value, 'Raw material'); assert.equal(a.project.value, 'OT-2215'); assert.equal(a.purchase_type.value, 'direct_to_job');
    const k = c(sample('f2-consumables'));
    assert.equal(k.spend_category.value, 'Welding consumables'); assert.equal(k.project.value, null); assert.equal(k.purchase_type.value, 'stock');
    const g = c(sample('f3-gases'));
    assert.equal(g.spend_category.value, 'Industrial gases'); assert.equal(g.purchase_type.value, 'stock');
});
