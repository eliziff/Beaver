import { useEffect, useState } from "react";
import { acceptOrganizationInvitation, changeOrganizationMember, createOrganization, deleteOrganization,
  getOrganization, inviteOrganizationMember, listOrganizations, renameOrganization, revokeOrganizationInvitation,
  type Organization, type OrganizationDetail } from "@/app/lib/api/organizations";
import { errorMessage } from "@/app/lib/utils";
import { useAuth } from "@/app/contexts/AuthContext";
import { useMfaAction } from "../account/useMfaAction";
import { Button } from "../ui/button";
import { ConfirmPopup } from "../popups/ConfirmPopup";

const field = "rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900";
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
    <h2 className="text-base font-semibold">Organizations</h2>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget, name = String(new FormData(form).get("name"));
      mutate(async () => { const org = await createOrganization(name); select(org.id); form.reset(); });
    }}>
      <label className="grid flex-1 gap-1 text-sm">Organization name<input name="name" className={field} required maxLength={160} disabled={busy} /></label>
      <Button type="submit" disabled={busy}>Create</Button>
    </form>
    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget, token = String(new FormData(form).get("token")).trim();
      mutate(async () => { const result = await acceptOrganizationInvitation(token); select(result.org_id); form.reset(); });
    }}>
      <label className="grid flex-1 gap-1 text-sm">Invitation code<input name="token" className={field} required autoComplete="off" disabled={busy} /></label>
      <Button type="submit" variant="outline" disabled={busy}>Join</Button>
    </form>
    {organizations.length > 0 && <label className="grid gap-1 text-sm">Manage organization<select className={field} value={selected} onChange={(event) => select(event.target.value)} disabled={busy}>
      <option value="">Choose an organization</option>{organizations.map((org) => <option value={org.id} key={org.id}>{org.name}</option>)}
    </select></label>}
    {detail && <>
      {admin && <form key={detail.organization.name} className="flex items-end gap-2" onSubmit={(event) => {
        event.preventDefault(); const name = String(new FormData(event.currentTarget).get("name"));
        mutate(() => renameOrganization(selected, name));
      }}><label className="grid flex-1 gap-1 text-sm">Name<input className={field} name="name" defaultValue={detail.organization.name} required maxLength={160} disabled={busy} /></label>
        <Button type="submit" variant="outline" disabled={busy}>Rename</Button></form>}
      <ul className="divide-y divide-gray-200">{detail.members.map((member) => <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
        <span className="break-all">{member.display_name || member.email || "Local account"}</span>
        <div className="flex gap-2">{admin ? <select aria-label={`Role for ${member.email ?? member.display_name ?? "local account"}`} className={field}
          value={member.role} disabled={busy} onChange={(event) => mutate(() => changeOrganizationMember(selected, member.user_id, event.target.value as "admin" | "member"))}>
          <option value="member">Member</option><option value="admin">Admin</option>
        </select> : <span>{member.role}</span>}
          {(admin || member.user_id === user?.id) && <Button variant="outline" disabled={busy} onClick={() => mutate(async () => {
            await changeOrganizationMember(selected, member.user_id, null); if (member.user_id === user?.id) select("");
          })}>{member.user_id === user?.id ? "Leave" : "Remove"}</Button>}
        </div>
      </li>)}</ul>
      {admin && <>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
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
          <label className="grid flex-1 gap-1 text-sm">Invite by email<input name="email" type="email" className={field} required disabled={busy} /></label>
          <label className="grid gap-1 text-sm">Role<select name="role" className={field} disabled={busy}><option value="member">Member</option><option value="admin">Admin</option></select></label>
          <Button type="submit" disabled={busy}>Create invitation</Button>
        </form>
        {invitation && <label className="grid gap-1 text-sm">Share this invitation code<input className={field} readOnly value={invitation} onFocus={(event) => event.currentTarget.select()} /></label>}
        <ul>{detail.invitations.map((item) => <li key={item.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
          <span>{item.email} · expires {new Date(item.expires_at).toLocaleDateString()}</span>
          <Button variant="outline" disabled={busy} onClick={() => mutate(() => revokeOrganizationInvitation(selected, item.id))}>Revoke</Button>
        </li>)}</ul>
        <Button variant="danger" disabled={busy} onClick={() => setDeleting(true)}>Delete organization</Button>
      </>}
    </>}
    <ConfirmPopup open={deleting} title="Delete organization?" message="Move or delete its projects and workflows first. Members and invitations will be removed."
      confirmLabel="Delete organization" confirmStatus={busy ? "loading" : "idle"} onCancel={() => setDeleting(false)}
      onConfirm={() => mutate(async () => { await deleteOrganization(selected); setDeleting(false); select(""); })} />
    {mfaPopup}
  </section>;
}
