import { render } from "preact";

import App from "./App";
import "./styles/harbor-ui.css";
import "./styles/components.css";
import "./styles/components/instructor-analytics.css";
import "./styles/components/instructor-assessments.css";
import "./styles/components/instructor-lms.css";
import "./styles/components/instructor-roster.css";
import "./styles/components/manual-scoring.css";
import "./styles/components/student-pages.css";
import "./styles/components/results-ops.css";
import "./styles/components/qti-color-theme.css";
import "./styles/components/charts-renderer.css";
import "./styles/components/session.css";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Harbor web root element #app was not found.");
}

render(<App />, root);
