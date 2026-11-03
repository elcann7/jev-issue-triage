// All question wording lives in one place, so it is easy to audit and edit.
// Rules (from the TypeSafe skill): each question is one judgment; a "true" answer means "yes";
// the false criterion is a concrete situation; the question names its own subject.

export const QUESTIONS = {
  is_bug: {
    type: "noul",
    instructions:
      "`issue` reports a defect in `project`.",
    criteria: {
      true: "The author describes an error message, a crash, or unexpected behavior of functionality that already exists.",
      false: "The author asks for something new, asks how to do something, or comments on documentation.",
    },
  },
  is_feature_request: {
    type: "noul",
    instructions: "`issue` asks for a new capability that `project` does not have yet.",
    criteria: {
      true: "The author describes something they would like the project to be able to do, which it cannot do today.",
      false: "The author reports a failure of existing functionality, or asks how to use what already exists.",
    },
  },
  is_question: {
    type: "noul",
    instructions: "`issue` asks for help using `project`.",
    criteria: {
      true: "The author asks how to do something, or what is going wrong in their own configuration.",
      false: "The author reports a defect in the project itself or requests a change to the project.",
    },
  },
  is_docs: {
    type: "noul",
    instructions:
      "`issue` is about a problem in the documentation of `project`.",
    criteria: {
      true: "The author points at a page, README section, or example and says it is missing, wrong, outdated, or confusing.",
      false: "The author talks about the behavior or features of the software itself, not about its documentation.",
    },
  },
  has_repro: {
    type: "noul",
    instructions:
      "`issue.body` contains a way to reproduce the problem.",
    criteria: {
      true: "The body lists numbered steps, a code snippet, or an exact command that triggers the problem.",
      false: "The body describes the problem only in general terms, without steps or code to reproduce it.",
    },
  },
  describes_vulnerability: {
    type: "noul",
    instructions: "`issue` describes a security vulnerability in `project`.",
    criteria: {
      true: "The author describes a way to attack the project or its users.",
      false: "The issue is about ordinary functionality and mentions no vulnerability.",
    },
  },
  leaks_secret: {
    type: "noul",
    instructions: "`issue.body` contains a secret credential.",
    criteria: {
      true: "The text includes a password, an access token, an API key, or a private key.",
      false: "The text contains no credentials.",
    },
  },
  is_spam: {
    type: "noul",
    instructions: "`issue` is spam.",
    criteria: {
      true: "The text promotes a product or service, contains unrelated links, is meaningless, or has nothing to do with the project.",
      false: "The text is a genuine message addressed to the maintainers of the project.",
    },
  },
  severity: {
    type: "score",
    instructions: "How badly does the problem described in `issue` affect its author?",
    criteria: [
      "A cosmetic problem or minor inconvenience; everything important still works.",
      "A feature does not work as expected, but the author has a workaround.",
      "An important feature is broken for the author and there is no workaround.",
      "Data is lost or exposed, or the project cannot be used at all.",
    ],
  },
};

export const SEVERITY_LEVELS = ["low", "medium", "high", "critical"];

/** The state sent to the model: named fields, only what the questions need. */
export function buildState({ title, body, projectName, projectDescription }, maxBodyChars = 6000) {
  const text = body ?? "";
  const truncated = text.length > maxBodyChars;
  return {
    project: { name: projectName, description: projectDescription || "(no description)" },
    issue: {
      title: title ?? "",
      body: truncated ? text.slice(0, maxBodyChars) + "\n[... truncated ...]" : text,
    },
  };
}
