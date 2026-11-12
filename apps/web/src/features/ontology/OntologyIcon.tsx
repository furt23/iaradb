import SvgIcon, { type SvgIconProps } from "@mui/material/SvgIcon";

/** The ontology's mark: a term (the filled node) linked to the three things it is defined by. Shown where Iara read the teams' ontology. */
export function OntologyIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <path d="M12 9.2V6.9M9.7 13.4 7.3 15.9M14.3 13.4l2.4 2.5" />
        <circle cx="12" cy="4.6" r="2.3" />
        <circle cx="5.6" cy="17.7" r="2.3" />
        <circle cx="18.4" cy="17.7" r="2.3" />
      </g>
      <circle cx="12" cy="11.7" r="2.7" />
    </SvgIcon>
  );
}
