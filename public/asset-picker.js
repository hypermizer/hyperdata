import { displayAssetSymbol, resolveAsset, searchAssets } from "./lib/assets.js?v=20260720-stream";

export class AssetPicker {
  constructor(root) {
    this.root = root;
    this.input = root.querySelector("[data-asset-input]");
    this.hidden = root.querySelector("[data-asset-value]");
    this.list = root.querySelector("[data-asset-list]");
    this.catalog = [];
    this.matches = [];
    this.activeIndex = -1;
    this.disabled = false;
    this.input.addEventListener("focus", () => this.open());
    this.input.addEventListener("input", () => { this.syncValue(); this.open(); });
    this.input.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.list.addEventListener("pointerdown", (event) => {
      const option = event.target.closest("button[data-asset-id]");
      if (!option) return;
      event.preventDefault();
      this.select(option.dataset.assetId);
    });
    document.addEventListener("pointerdown", (event) => { if (!this.root.contains(event.target)) this.close(); });
  }

  setCatalog(catalog) {
    this.catalog = catalog;
    this.syncValue();
    this.render();
  }

  setDisabled(disabled) {
    this.disabled = Boolean(disabled);
    this.input.disabled = this.disabled;
    if (this.disabled) this.close();
  }

  get value() {
    return this.hidden.value || resolveAsset(this.catalog, this.input.value)?.id || "";
  }

  clear() {
    this.input.value = "";
    this.hidden.value = "";
    this.activeIndex = -1;
    this.render();
  }

  open() {
    if (this.disabled || !this.catalog.length) return;
    this.root.classList.add("is-open");
    this.input.setAttribute("aria-expanded", "true");
    this.render();
  }

  close() {
    this.root.classList.remove("is-open");
    this.input.setAttribute("aria-expanded", "false");
    this.activeIndex = -1;
    this.input.removeAttribute("aria-activedescendant");
  }

  syncValue() {
    this.hidden.value = resolveAsset(this.catalog, this.input.value)?.id ?? "";
  }

  select(id) {
    const asset = this.catalog.find((item) => item.id === id);
    if (!asset) return;
    this.input.value = displayAssetSymbol(asset);
    this.hidden.value = asset.id;
    this.close();
  }

  onKeyDown(event) {
    if (event.key === "Escape") return this.close();
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    if (!this.root.classList.contains("is-open")) this.open();
    if (!this.matches.length) return;
    event.preventDefault();
    if (event.key === "Enter") {
      const asset = this.matches[Math.max(0, this.activeIndex)];
      return this.select(asset.id);
    }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    this.activeIndex = (this.activeIndex + direction + this.matches.length) % this.matches.length;
    this.render();
  }

  render() {
    this.matches = searchAssets(this.catalog, this.input.value);
    if (this.activeIndex >= this.matches.length) this.activeIndex = -1;
    this.list.replaceChildren(...this.matches.map((asset, index) => this.option(asset, index)));
    this.list.hidden = !this.matches.length;
  }

  option(asset, index) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `${this.list.id}-option-${index}`;
    button.dataset.assetId = asset.id;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === this.activeIndex));
    button.className = index === this.activeIndex ? "is-active" : "";
    const symbol = document.createElement("strong");
    symbol.textContent = displayAssetSymbol(asset);
    const price = document.createElement("span");
    price.className = "asset-picker-price";
    price.textContent = formatMark(asset.markPrice);
    const leverage = document.createElement("span");
    leverage.className = "asset-picker-leverage";
    leverage.textContent = `${asset.maxLeverage ?? "—"}×`;
    button.append(symbol, price, leverage);
    if (index === this.activeIndex) this.input.setAttribute("aria-activedescendant", button.id);
    return button;
  }
}

function formatMark(value) {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 6 : 2 })}`;
}
