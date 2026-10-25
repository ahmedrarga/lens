import { useCallback, useEffect, useState } from 'react';
import { getMe, logout, type Me } from './api.js';

const NONE: Me = { authEnabled: false, user: null };
export function useMe() {
  const [me, setMe] = useState<Me>(NONE);
  const refresh = useCallback(() => { getMe().then(setMe); }, []);
  useEffect(refresh, [refresh]);
  return { me, refresh };
}

export const signInHref = '/auth/github/login';

/** Header badge: nothing when auth is off; "Sign in with GitHub" or avatar + logout otherwise. */
export function AuthBadge() {
  const { me, refresh } = useMe();
  if (!me.authEnabled) return null;
  if (!me.user) return <a className="btn btn--small" href={signInHref}>Sign in with GitHub</a>;
  const u = me.user;
  return (
    <span className="auth-badge">
      {u.avatarUrl && <img src={u.avatarUrl} alt="" width={22} height={22} className="avatar" />}
      <span title={u.name ?? u.login}>{u.login}</span>
      <button className="btn btn--small" onClick={() => logout().then(refresh)}>Log out</button>
    </span>
  );
}

export function SignInPrompt({ message = 'Sign in with GitHub to continue.' }: { message?: string }) {
  return <p className="signin-prompt" role="alert">{message} <a className="btn btn--small btn--primary" href={signInHref}>Sign in with GitHub</a></p>;
}
