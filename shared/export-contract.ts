// Parser schemas allow four levels of 64-character keys, joined by dots.
export const maximumExportFieldPathLength=4*64+3;
// Repeated-row sources may additionally use the reserved "$item." prefix.
export const maximumExportColumnSourceLength=maximumExportFieldPathLength+'$item.'.length;
