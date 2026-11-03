// Comments are fixed templates: the model never writes text under a maintainer's name.
const FOOTER = "\n\n<sub>Automatic triage with TypeSafe Jev. A maintainer will review this.</sub>";

export const COMMENTS = {
  repro:
    "Thanks for the report! To help us reproduce this, could you add the steps, code, or command that trigger the problem, " +
    "and the version you are using?" + FOOTER,
  security:
    "This report may involve a security issue. Please avoid posting sensitive details publicly. If you have not already, " +
    "use the repository's private vulnerability reporting (Security tab, then \"Report a vulnerability\") or contact the maintainers privately." + FOOTER,
};
