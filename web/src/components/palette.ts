import { reactive } from "vue";

/** Shared open state, so any search button can open the palette and the inbox can open "add". */
export const palette = reactive({ open: false, addOpen: false });
export const openPalette = () => (palette.open = true);
export const openAdd = () => (palette.addOpen = true);
