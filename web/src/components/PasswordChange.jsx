import { useActionState } from 'react';
import { api } from '../lib/api.js';
import { Modal, PasswordInput, Field, ErrorText, SubmitButton, useToast } from './ui.jsx';

/** Change your own password. forced = first sign-in with a temporary password (cannot be dismissed). */
export function PasswordChange({ forced = false, onDone, onClose }) {
  const toast = useToast();
  const [error, action, pending] = useActionState(async (_prev, form) => {
    const current = form.get('current');
    const next = form.get('next');
    if (next !== form.get('again')) return 'New passwords do not match';
    try {
      await api.post('/api/auth/change-password', { current, next });
      toast('Password updated', 'success');
      onDone?.();
      return null;
    } catch (e) {
      return e.message;
    }
  }, null);

  return (
    <Modal title={forced ? 'Set a new password' : 'Change password'} onClose={onClose} closable={!forced}>
      <form action={action} method="post" className="flex flex-col gap-4" autoComplete="off">
        {forced && <p className="text-sm text-muted">For security you must replace the temporary password before continuing.</p>}
        <Field label="Current password"><PasswordInput name="current" autoComplete="current-password" required /></Field>
        <Field label="New password" help="At least 10 characters with letters and numbers."><PasswordInput name="next" required minLength={10} /></Field>
        <Field label="Repeat new password"><PasswordInput name="again" required /></Field>
        <ErrorText>{error}</ErrorText>
        <SubmitButton pending={pending} className="btn btn-primary w-full">Save password</SubmitButton>
      </form>
    </Modal>
  );
}
