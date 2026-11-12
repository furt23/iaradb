/**
 * How the settings panel tells its layers apart. Headings are small and muted, in capitals: they are not to be
 * clicked. The data set on a chart sits on a lighter block. What can be done is in the accent color.
 */

export const PANEL_HEADING = { fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary" } as const;

/** The panel's inputs: an outline that shows on its dark surface, so a field does not read as plain text. */
export const PANEL_FIELDS = { "& .MuiOutlinedInput-notchedOutline": { borderColor: "text.disabled" } } as const;
