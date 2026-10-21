import React from "react";
import { useSearchParams } from "react-router-dom";
import type { InpulseApiClient } from "@generated/api";
import { useAuth } from "@features/auth/auth-context";
import { AdminUsersPageView } from "@features/users/AdminUsersPageView";

export interface SettingsPageProps {
  readonly client?: InpulseApiClient | undefined;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ client }) => {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialTab =
    tabParam === "projectMembers" ||
    tabParam === "aiAssist" ||
    tabParam === "wecomRobot"
      ? tabParam
      : undefined;

  return (
    <AdminUsersPageView
      currentUserId={user?.id}
      isAdmin={user?.isAdmin === true}
      {...(initialTab ? { initialTab } : {})}
      {...(client ? { client } : {})}
    />
  );
};

export default SettingsPage;
