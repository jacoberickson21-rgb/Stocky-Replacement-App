// Shared by the server scope query and the browser filter UI — keep free of
// server-only imports.

export type StockLevelFilter = "all" | "in_stock" | "zero_or_negative";
export type BarcodeFilter = "all" | "has" | "missing";

export type StocktakeScope = {
  vendor: string;
  productType: string;
  tag: string;
  status: string;
  stock: StockLevelFilter;
  barcode: BarcodeFilter;
  q: string;
  excludedVariantIds: string[];
  excludedProductIds: string[];
};

export const EMPTY_SCOPE: StocktakeScope = {
  vendor: "",
  productType: "",
  tag: "",
  status: "",
  stock: "all",
  barcode: "all",
  q: "",
  excludedVariantIds: [],
  excludedProductIds: [],
};
