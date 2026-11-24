const { test } = require('node:test');
const assert = require('node:assert/strict');
const { numericSignature, conflict, prepareCandidates, suggest, lettersOnly } = require('../suggestions');

// Link suggestions for "Bring to catalog". The cases are the ones that should be suggested and, above all,
// the ones that looked very alike but were something else. Descriptions stay Spanish: they are printed invoice text.

const candidates = prepareCandidates([
    { text: 'CINTA MASKING TAPE 24 MM X 50 M', via: 'link', id: 1, code: 'CIN-MASKING-24', name: 'Masking tape 24 mm' },
    { text: 'FLEXOMETRO GRIPPER CONTRA IMPACTOS 5 M CINTA 19 MM, TRUPER', via: 'link', id: 2, code: 'HER-FLEXOMETRO-5M-19', name: 'Tape measure 5 m' },
    { text: 'MANDIL DE CARNAZA STD', via: 'link', id: 3, code: 'EPP-MANDIL-CARNAZA', name: 'Leather apron' },
    { text: 'GUANTE PROTECTOR ARGONERO LARGO', via: 'link', id: 4, code: 'EPP-GUANTE-ARGONERO', name: 'Argon welding glove' },
    { text: 'DISCO D/DESBASTE P/METAL 4 1/2" X 1/4" X 7/8" F27, WESTON', via: 'link', id: 5, code: 'ABR-DISCO-DESB-4_5-F27', name: 'Grinding disc 4.5' },
    { text: 'Punta de contacto MILLER 0.045', via: 'name', id: 6, code: 'PCT-MILL-0_045', name: 'Contact tip MILLER 0.045' },
    { text: 'MARCADOR DE JABON GRADO "A", WESTON', via: 'link', id: 7, code: 'SOLD-MARCADOR-JABON', name: 'Soapstone marker' },
    { text: 'RECARGA DE GAS OXIGENO 9.5 M3', via: 'link', id: 8, code: 'GAS-OXIGENO-9_5M3', name: 'Oxygen 9.5 m3' },
]);

test('measure signature: fractions, mixed numbers and numbers stuck to letters', () => {
    assert.equal(numericSignature('DISCO 4 1/2" X 1/4"'), numericSignature('DISCO 4.5 X 0.25'));
    assert.equal(numericSignature('CINTA 24MMX50M'), numericSignature('CINTA 24 MM X 50 M'));
    assert.notEqual(numericSignature('MANERAL 3/8"'), numericSignature('MANERAL 1/2"'));
    assert.equal(numericSignature('GUANTE ARGONERO'), '');
});

test('exclusive words: substance, part, direction and color change the item', () => {
    assert.equal(conflict('RECARGA DE GAS ARGON 9.5', 'RECARGA DE GAS OXIGENO 9.5'), true);
    assert.equal(conflict('MANGA DE CARNAZA', 'MANDIL DE CARNAZA'), true);
    assert.equal(conflict('TUNGSTENO GRIS 3/32', 'TUNGSTENO MORADO 3/32'), true);
    assert.equal(conflict('MACHUELO IZQUIERDO', 'MACHUELO DERECHO'), true);
    assert.equal(conflict('GUANTE ARGONERO', 'GUANTE ARGONERO LARGO'), false);
});

test('the same description with other punctuation is recognised as such', () => {
    const s = suggest('CINTA MASKING TAPE 24MMX50M', candidates);
    assert.equal(s.product.code, 'CIN-MASKING-24');
    assert.equal(s.reason, 'same_form');
    assert.equal(lettersOnly('CINTA MASKING TAPE 24MMX50M'), lettersOnly('CINTA MASKING TAPE 24 MM X 50 M'));
});

test('similar with the same measures: suggested', () => {
    const s = suggest('GUANTE PROTECTOR ARGONERO LARGO, PAR', candidates);
    assert.equal(s.product.code, 'EPP-GUANTE-ARGONERO');
    assert.equal(s.reason, 'similar');
    assert.ok(s.similarity >= 0.6);
});

test('another size of the same item is NOT suggested, even if the text is almost equal', () => {
    assert.equal(suggest('CINTA MASKING TAPE 19 MM X 50 M', candidates), null);
    assert.equal(suggest('FLEXOMETRO GRIPPER CONTRA IMPACTOS 8 M CINTA 25 MM, TRUPER', candidates), null);
    assert.equal(suggest('RECARGA DE GAS OXIGENO 10 M3', candidates), null);
});

test('an exclusive word stops the suggestion even if everything else matches', () => {
    assert.equal(suggest('MANGA DE CARNAZA STD', candidates), null);
    assert.equal(suggest('RECARGA DE GAS ARGON 9.5 M3', candidates), null);
});

test('below the threshold nothing is suggested: different brand or object', () => {
    // Same measures, other brand: "Tregaskiss" is not "Miller".
    assert.equal(suggest('PUNTA DE CONTACTO TIPO TREGASKISS 0.045"', candidates), null);
    // The marker holder is not the marker.
    assert.equal(suggest('PORTA MARCADOR PARA MARCADOR DE JABON, WESTON', candidates), null);
});

// Edge cases that came up in review

test('colors: the blue glove is not the red one, and "dorada" clashes with "morado"', () => {
    const gloves = prepareCandidates([
        { text: 'GUANTE PARA SOLDADOR ROJO', via: 'link', id: 20, code: 'EPP-GUANTE-SOLDADOR-ROJO', name: 'Red welder glove' },
    ]);
    assert.equal(suggest('GUANTE PARA SOLDADOR AZUL', gloves), null);
    assert.equal(conflict('TUNGSTENO PUNTA DORADA 3/32', 'TUNGSTENO MORADO 3/32'), true);
    assert.equal(conflict('FIBRA NEGRA 3M P96', 'FIBRA VERDE 3M P96'), true);
    // A color on one side only does not clash: it may just be more detail.
    assert.equal(conflict('GUANTE ARGONERO', 'GUANTE ARGONERO GRIS'), false);
});

test('consumable brand and disc type change the item', () => {
    assert.equal(conflict('PUNTA DE CONTACTO P/TWECO 0.045', 'Punta de contacto MILLER 0.045'), true);
    assert.equal(conflict('DISCO DE CORTE 7" F27', 'DISCO DE DESBASTE 7" F27'), true);
});

test('decimals without a leading zero, and mixed numbers that are not', () => {
    assert.equal(numericSignature('PUNTA TREGASKISS .045"'), numericSignature('PUNTA TREGASKISS 0.045"'));
    assert.notEqual(numericSignature('BROCA .5 MM'), numericSignature('Broca 5 mm'));
    assert.equal(numericSignature('MACHUELO M5X.8'), numericSignature('MACHUELO M5X0.8'));
    // "7018 1/8" is a 7018 electrode of 1/8, not 7018.125.
    assert.equal(numericSignature('ELECTRODO 7018 1/8"'), numericSignature('ELECTRODO 7018 DE 1/8"'));
    assert.equal(numericSignature('DISCO 4 1/2"'), numericSignature('DISCO 4.5"'));
});

test('if two different products pass by similarity, none is suggested', () => {
    const two = prepareCandidates([
        { text: 'GUANTE DE SOLDADOR CON KEVLAR LARGO', via: 'link', id: 30, code: 'EPP-A', name: 'A' },
        { text: 'GUANTE DE SOLDADOR CON KEVLAR CORTO', via: 'link', id: 31, code: 'EPP-B', name: 'B' },
    ]);
    assert.equal(suggest('GUANTE DE SOLDADOR CON KEVLAR', two), null);
});

test('the suggestion says whether there were measures, so it never claims "same measures" without any', () => {
    assert.equal(suggest('GUANTE PROTECTOR ARGONERO LARGO, PAR', candidates).has_numbers, false);
    assert.equal(suggest('CINTA MASKING TAPE 24MMX50M', candidates).has_numbers, true);
});
