// Analyzes one issue: build the state -> ask Jev -> decide in code. Used by the dashboard server and the watcher.
import { QUESTIONS, buildState } from "./questions.mjs";
import { decide, DEFAULTS } from "./decide.mjs";

export function makeAnalyze({ askJev, model = "jev-latest" }) {
  return async function analyze(issue, project, thresholds = DEFAULTS) {
    const state = buildState({ title: issue.title, body: issue.body, projectName: project.name, projectDescription: project.description });
    const response = await askJev({ state, questions: QUESTIONS, model });
    return {
      request: { model, state, questions: QUESTIONS },
      response: { model: response.model, answers: response.answers, usage: response.usage },
      decision: decide(response.answers, thresholds),
    };
  };
}
