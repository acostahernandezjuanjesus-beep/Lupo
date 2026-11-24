// One expression for the summary and the filters. An unknown count wins even if there is a minimum.
function levelSql(alias = '') {
    const p = alias ? `${alias}.` : '';
    return `CASE WHEN ${p}count_pending THEN 'uncounted'
        WHEN ${p}minimum IS NULL THEN 'no_minimum'
        WHEN ${p}quantity <= ${p}minimum THEN 'below_min'
        WHEN ${p}quantity <= ${p}minimum * 1.25 THEN 'restock'
        ELSE 'ample' END`;
}
const LEVELS = ['uncounted', 'no_minimum', 'below_min', 'restock', 'ample'];
module.exports = { levelSql, LEVELS };
