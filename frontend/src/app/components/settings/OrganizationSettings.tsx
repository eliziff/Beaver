import { useEffect, useState } from "react";
import { acceptOrganizationInvitation, changeOrganizationMember, createOrganization, deleteOrganization,
  getOrganization, inviteOrganizationMember, listOrganizations, renameOrganization, revokeOrganizationInvitation,
  type Organization, type OrganizationDetail } from "@/app/lib/api/organizations";
import { errorMessage } from "@/app/lib/utils";
import { useAuth } from "@/app/contexts/AuthContext";
import { useMfaAction } from "../account/useMfaAction";
import { Button } from "../ui/button";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { AccountSection } from "@/app/(pages)/account/AccountSection";
import { ModalTextInput } from "../modals/ModalTextInput";
import { ModalSelect } from "../modals/ModalSelect";

const field = "h-9 w-full min-w-0 rounded-md border border-gray-300 bg-white px-3 text-base text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 sm:text-sm";
export function OrganizationSettings() {
  const { user } = useAuth(), { runMfa, mfaPopup } = useMfaAction();
  const [organizations, setOrganizations] = useState<Organization[]>([]), [selected, select] = useState("");
  const [detail, setDetail] = useState<OrganizationDetail | null>(null), [revision, refresh] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [invitation, setInvitation] = useState("");
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    listOrganizations().then((list) => { if (!cancelled) setOrganizations(list.organizations); })
      .catch((error) => { if (!cancelled) setError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [revision]);
  useEffect(() => {
    let cancelled = false; setDetail(null); setInvitation("");
    if (selected) getOrganization(selected).then((value) => { if (!cancelled) setDetail(value); })
      .catch((error) => { if (!cancelled) setError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [selected, revision]);
  const mutate = (work: () => Promise<unknown>) => void runMfa(async () => {
    setBusy(true); setError("");
    try { await work(); refresh((value) => value + 1); }
    finally { setBusy(false); }
  }, { onError: (error) => setError(errorMessage(error)) });
  const admin = detail?.organization.role === "admin";
  return <section className="space-y-5">
    <div>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Organizations</h2>
      <p className="text-sm leading-6 text-gray-600">Share projects and workflows with your team.</p>
    </div>
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
    {organizations.length > 0 && <label className="grid gap-2 text-sm font-medium text-gray-900" htmlFor="settings-organization">Manage organization
      <ModalSelect id="settings-organization" value={selected} onChange={select} disabled={busy}
        placeholder="Choose an organization" ariaLabel="Manage organization"
        options={organizations.map((org) => ({ value: org.id, label: org.name }))} />
    </label>}
    {selected && !detail && !error && <p role="status" className="text-sm text-gray-500">Loading organization...</p>}
    {detail && <AccountSection className="space-y-6 p-4">
      {admin && <form key={detail.organization.name} className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
        event.preventDefault(); const name = String(new FormData(event.currentTarget).get("name"));
        mutate(() => renameOrganization(selected, name));
      }}><label className="grid min-w-0 flex-1 gap-2 text-sm font-medium text-gray-900">Name<ModalTextInput name="name" defaultValue={detail.organization.name} required maxLength={160} disabled={busy} /></label>
        <Button type="submit" variant="outline" disabled={busy}>Rename</Button></form>}
      <section className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-900">Members</h3>
      <ul className="divide-y divide-gray-200">{detail.members.map((member) => <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
        <div className="min-w-0 flex-1 text-gray-900">
          <p className="break-words font-medium">{member.display_name || member.email || "Local account"}</p>
          {member.display_name && member.email && <p className="mt-0.5 break-all text-xs text-gray-500">{member.email}</p>}
        </div>
        <div className="flex items-center gap-2">{admin ? <div className="w-28"><ModalSelect
          id={`member-role-${member.user_id}`} ariaLabel={`Role for ${member.email ?? member.display_name ?? "local account"}`}
          value={member.role} disabled={busy} placeholder={null}
          onChange={(value) => mutate(() => changeOrganizationMember(selected, member.user_id, value as "admin" | "member"))}
          options={[{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }]} /></div>
          : <span className="text-xs text-gray-500">{member.role === "admin" ? "Admin" : "Member"}</span>}
          {(admin || member.user_id === user?.id) && <Button variant="ghost" size="compact" disabled={busy} onClick={() => mutate(async () => {
            await changeOrganizationMember(selected, member.user_id, null); if (member.user_id === user?.id) select("");
          })}>{member.user_id === user?.id ? "Leave" : "Remove"}</Button>}
        </div>
      </li>)}</ul>
      </section>
      {admin && <>
        <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">Invite a member</h3>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
          event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
          // Keep the newly issued code visible across the roster refresh.
          void runMfa(async () => {
            setBusy(true); setError("");
            try {
              const result = await inviteOrganizationMember(selected, String(data.get("email")), String(data.get("role")) as "admin" | "member");
              setDetail(await getOrganization(selected)); setInvitation(result.token); form.reset();
            } finally { setBusy(false); }
          }, { onError: (error) => setError(errorMessage(error)) });
        }}>
          <label className="grid min-w-0 flex-[1_1_12rem] gap-2 text-sm font-medium text-gray-900">Email<ModalTextInput name="email" type="email" autoComplete="email" required disabled={busy} /></label>
          <label className="grid w-28 gap-2 text-sm font-medium text-gray-900">Role<select name="role" className={field} disabled={busy}><option value="member">Member</option><option value="admin">Admin</option></select></label>
          <Button type="submit" disabled={busy}>Create invitation</Button>
        </form>
        {invitation && <label className="grid gap-2 text-sm font-medium text-gray-900">Share this invitation code<ModalTextInput className="font-mono" readOnly value={invitation} onFocus={(event) => event.currentTarget.select()} /></label>}
        {detail.invitations.length > 0 && <ul className="divide-y divide-gray-200">{detail.invitations.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
          <div className="min-w-0"><p className="break-all text-gray-900">{item.email}</p>
            <p className="mt-0.5 text-xs text-gray-500">Expires {new Date(item.expires_at).toLocaleDateString()}</p></div>
          <Button variant="ghost" size="compact" disabled={busy} onClick={() => mutate(() => revokeOrganizationInvitation(selected, item.id))}>Revoke</Button>
        </li>)}</ul>}
        </section>
        <div className="border-t border-gray-200 pt-4">
          <Button variant="ghost" className="px-0 text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300" disabled={busy} onClick={() => setDeleting(true)}>Delete organization</Button>
        </div>
      </>}
    </AccountSection>}
    <div className="grid gap-4 sm:grid-cols-2">
      <AccountSection className="p-4">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">Create an organization</h3>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault(); const form = event.currentTarget, name = String(new FormData(form).get("name"));
          mutate(async () => { const org = await createOrganization(name); select(org.id); form.reset(); });
        }}>
          <label className="grid gap-2 text-sm font-medium text-gray-900">Organization name<ModalTextInput name="name" required maxLength={160} autoComplete="organization" disabled={busy} /></label>
          <Button type="submit" disabled={busy}>Create organization</Button>
        </form>
      </AccountSection>
      <AccountSection className="p-4">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">Join an organization</h3>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault(); const form = event.currentTarget, token = String(new FormData(form).get("token")).trim();
          mutate(async () => { const result = await acceptOrganizationInvitation(token); select(result.org_id); form.reset(); });
        }}>
          <label className="grid gap-2 text-sm font-medium text-gray-900">Invitation code<ModalTextInput name="token" required autoComplete="off" disabled={busy} /></label>
          <Button type="submit" variant="outline" disabled={busy}>Join organization</Button>
        </form>
      </AccountSection>
    </div>
    <ConfirmPopup open={deleting} title="Delete organization?" message="Move or delete its projects and workflows first. Members and invitations will be removed."
      confirmLabel="Delete organization" confirmStatus={busy ? "loading" : "idle"} onCancel={() => setDeleting(false)}
      onConfirm={() => mutate(async () => { await deleteOrganization(selected); setDeleting(false); select(""); })} />
    {mfaPopup}
  </section>;
}
