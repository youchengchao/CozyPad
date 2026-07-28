import { useState } from 'react';
import type { ConnectionProfile } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';

interface ConnectionManagerProps {
  profiles: ConnectionProfile[];
  onClose(): void;
  onChanged(): void | Promise<void>;
}

interface FormState {
  id?: string;
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  rememberPassword: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  host: '',
  port: '22',
  username: '',
  password: '',
  rememberPassword: true,
};

export function ConnectionManager({ profiles, onClose, onChanged }: ConnectionManagerProps) {
  const bridge = getBridge();
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<FormState>) =>
    setForm((current) => (current ? { ...current, ...patch } : current));

  const save = async () => {
    if (!form) return;
    const port = Number(form.port);
    if (!form.name || !form.host || !form.username || !Number.isInteger(port)) {
      setError('name / host / port / username 為必填');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bridge.saveProfile({
        ...(form.id === undefined ? {} : { id: form.id }),
        name: form.name,
        host: form.host,
        port,
        username: form.username,
        ...(form.password === '' ? {} : { password: form.password }),
        rememberPassword: form.rememberPassword,
      });
      await onChanged();
      setForm(null);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profileId: string) => {
    setBusy(true);
    try {
      await bridge.deleteProfile({ profileId });
      await onChanged();
      setConfirmDelete(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>連線管理</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        {form === null ? (
          <>
            <div className="profile-list">
              {profiles.map((profile) => (
                <div key={profile.id} className="profile-row">
                  <div className="profile-row-main">
                    <span className="profile-row-name">
                      {profile.name}
                      {profile.hasPassword ? (
                        <span className="lock" title="已記憶密碼（OS 加密）">
                          🔒
                        </span>
                      ) : null}
                    </span>
                    <span className="profile-row-meta mono">
                      {profile.username}@{profile.host}:{profile.port}
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      setForm({
                        id: profile.id,
                        name: profile.name,
                        host: profile.host,
                        port: String(profile.port),
                        username: profile.username,
                        password: '',
                        rememberPassword: profile.hasPassword ?? false,
                      })
                    }
                  >
                    編輯
                  </button>
                  {confirmDelete === profile.id ? (
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => void remove(profile.id)}
                    >
                      確定刪除
                    </button>
                  ) : (
                    <button onClick={() => setConfirmDelete(profile.id)}>刪除</button>
                  )}
                </div>
              ))}
              {profiles.length === 0 ? (
                <p className="hint">還沒有連線，先新增一個。</p>
              ) : null}
            </div>
            <button className="primary" onClick={() => setForm({ ...EMPTY_FORM })}>
              ＋ 新增連線
            </button>
          </>
        ) : (
          <div className="profile-form">
            <label>
              名稱
              <input
                value={form.name}
                onChange={(event) => set({ name: event.target.value })}
                placeholder="Lab GPU box"
              />
            </label>
            <div className="form-row">
              <label className="grow">
                Host
                <input
                  value={form.host}
                  onChange={(event) => set({ host: event.target.value })}
                  placeholder="192.168.1.10"
                />
              </label>
              <label className="port">
                Port
                <input
                  value={form.port}
                  onChange={(event) => set({ port: event.target.value })}
                />
              </label>
            </div>
            <label>
              Username
              <input
                value={form.username}
                onChange={(event) => set({ username: event.target.value })}
              />
            </label>
            <label>
              Password{form.id !== undefined ? '（留空表示不變更）' : ''}
              <input
                type="password"
                value={form.password}
                onChange={(event) => set({ password: event.target.value })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.rememberPassword}
                onChange={(event) => set({ rememberPassword: event.target.checked })}
              />
              記住密碼（以 OS 安全儲存加密；不勾選則只保留到 app 關閉）
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <div className="form-actions">
              <button onClick={() => setForm(null)}>取消</button>
              <button className="primary" disabled={busy} onClick={() => void save()}>
                儲存
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface PasswordPromptProps {
  profile: ConnectionProfile;
  onCancel(): void;
  onSubmit(password: string, remember: boolean): void;
}

export function PasswordPrompt({ profile, onCancel, onSubmit }: PasswordPromptProps) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-narrow" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>輸入密碼</h2>
          <button className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>
        <p className="hint">
          {profile.username}@{profile.host}:{profile.port}
        </p>
        <input
          autoFocus
          type="password"
          value={password}
          placeholder="SSH password"
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && password !== '') onSubmit(password, remember);
          }}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          記住密碼（OS 加密儲存）
        </label>
        <div className="form-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={password === ''}
            onClick={() => onSubmit(password, remember)}
          >
            連線
          </button>
        </div>
      </div>
    </div>
  );
}
