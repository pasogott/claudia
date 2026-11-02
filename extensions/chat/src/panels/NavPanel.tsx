/**
 * NavPanel — Workspace + session list, plus the create-workspace modal.
 *
 * All state and handlers come from `useChatPage()`. Workspace ··· menu
 * actions and Settings menu actions are still no-ops — wire them up here
 * (or pass through to extension methods) once the backend supports them.
 */

import { useState } from "react";
import {
  NavigationDrawer,
  CreateWorkspaceModal,
  WorkspaceFoldersModal,
  logout,
  useAttentionSessions,
  type ActiveSessionRow,
} from "@anima/ui";
import type { WorkspaceMenuAction, SettingsMenuAction } from "@anima/ui";
import type { WorkspaceInfo } from "@anima/ui";
import { useChatPage } from "../context/ChatPageContext";

export function NavPanel() {
  const {
    workspaces,
    sessionsByWorkspace,
    hasMoreByWorkspace,
    activeWorkspace,
    activeSessionId,
    isConnected,
    showCreateWorkspaceModal,
    isCreatingWorkspace,
    onWorkspaceSelect,
    onSessionSelect,
    onRenameSession,
    onSetSessionDisposition,
    onSearchSessions,
    onNewSession,
    onNewWorkspace,
    onCloseCreateWorkspaceModal,
    onCreateWorkspace,
    onGetDirectories,
    onLoadMoreSessions,
    onPinWorkspace,
    onRefreshSessions,
    onLoadWorkspaceFolders,
    onUpdateWorkspaceFolders,
  } = useChatPage();
  const [foldersWorkspace, setFoldersWorkspace] = useState<WorkspaceInfo | null>(null);

  // The ACTIVE pane's data. Shares one poller with the app-wide banner — two
  // views of "what needs you" that disagreed would undercut the entire point.
  const { sessions: attention, now, acknowledge, setPinned } = useAttentionSessions();
  const activeSessions: ActiveSessionRow[] = attention.map((s) => ({
    sessionId: s.sessionId,
    workspaceId: s.workspaceId,
    workspaceName: s.workspaceName,
    title: s.title,
    firstPrompt: s.firstPrompt,
    runtimeStatus: s.runtimeStatus,
    disposition: s.disposition,
    waitingSince: s.waitingSince,
    pinned: s.pinned,
    parentSessionId: s.parentSessionId ?? null,
    folder: s.folder,
  }));

  const onWorkspaceMenuAction = (action: WorkspaceMenuAction, workspace: WorkspaceInfo) => {
    if (action === "pin") {
      void onPinWorkspace(workspace, !(workspace.pinned ?? false));
      return;
    }
    if (action === "refresh") {
      void onRefreshSessions(workspace);
      return;
    }
    if (action === "folders") {
      setFoldersWorkspace(workspace);
      return;
    }
    // Other actions (Open in Finder, Worktree, Rename, Archive, Remove)
    // remain stubs until backend support lands.
    console.log("[nav] workspace menu action (stub)", action, workspace.id);
  };

  const onSettingsMenuAction = (action: SettingsMenuAction) => {
    if (action === "logout") {
      logout();
      return;
    }
    console.log("[nav] settings menu action (stub)", action);
  };

  return (
    <>
      <NavigationDrawer
        workspaces={workspaces}
        sessionsByWorkspace={sessionsByWorkspace}
        hasMoreByWorkspace={hasMoreByWorkspace}
        activeWorkspace={activeWorkspace}
        activeSessionId={activeSessionId}
        isConnected={isConnected}
        onWorkspaceSelect={onWorkspaceSelect}
        onSessionSelect={onSessionSelect}
        onRenameSession={onRenameSession}
        onSetSessionDisposition={onSetSessionDisposition}
        onSearchSessions={onSearchSessions}
        activeSessions={activeSessions}
        activeNow={now}
        onAcknowledgeSession={(sessionId) => void acknowledge(sessionId)}
        onPinSession={(sessionId, pinned) => void setPinned(sessionId, pinned)}
        onNewSession={onNewSession}
        onNewWorkspace={onNewWorkspace}
        onLoadMoreSessions={onLoadMoreSessions}
        onWorkspaceMenuAction={onWorkspaceMenuAction}
        onSettingsMenuAction={onSettingsMenuAction}
      />
      <CreateWorkspaceModal
        isOpen={showCreateWorkspaceModal}
        onClose={onCloseCreateWorkspaceModal}
        onSubmit={onCreateWorkspace}
        onGetDirectories={onGetDirectories}
        isCreating={isCreatingWorkspace}
      />
      <WorkspaceFoldersModal
        workspace={foldersWorkspace}
        onClose={() => setFoldersWorkspace(null)}
        onLoad={onLoadWorkspaceFolders}
        onUpdate={onUpdateWorkspaceFolders}
      />
    </>
  );
}
