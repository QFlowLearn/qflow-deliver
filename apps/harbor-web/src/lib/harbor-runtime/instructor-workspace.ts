import { createInstructorAssignmentActions } from "./instructor-assignments";
import { createInstructorOperationsActions } from "./instructor-operations";
import { formatError } from "./formatting";
import {
  createInstructorWorkspaceState,
  type InstructorWorkspaceDependencies,
} from "./instructor-workspace-state";

export function createInstructorWorkspaceRuntime(input: InstructorWorkspaceDependencies) {
  const state = createInstructorWorkspaceState();
  const assignmentActions = createInstructorAssignmentActions({
    state,
    dependencies: input,
    formatError,
  });
  const operationsActions = createInstructorOperationsActions({
    state,
    assignmentActions,
    formatError,
  });
  const {
    buildInstructorAssignmentActor: _buildInstructorAssignmentActor,
    buildInstructorPolicyActor: _buildInstructorPolicyActor,
    clearInstructorWorkspace: _clearInstructorWorkspace,
    ...publicState
  } = state;

  return {
    ...publicState,
    ...assignmentActions,
    ...operationsActions,
  };
}
