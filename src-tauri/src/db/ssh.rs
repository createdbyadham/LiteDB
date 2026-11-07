//! SSH tunnels to databases behind a bastion.
//!
//! Listens on 127.0.0.1 on a free port and forwards each connection over the
//! SSH session to the database host, as `ssh -L` would. The pool, the editor
//! session and the MCP server all connect to that local port, so an agent
//! follows the app through the same tunnel while it is open.
//!
//! Host keys: a key recorded in ~/.ssh/known_hosts is honoured, and a changed
//! one is refused. A host seen for the first time is trusted and remembered in
//! LiteDB's own known_hosts file, which then refuses a later change too.

use russh::client::{self, Handle, Handler};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    /// password | key | agent
    pub auth: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

fn default_port() -> u16 {
    22
}

struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    /// Why the host key was refused, for an error better than "unknown key".
    refusal: Arc<Mutex<Option<String>>>,
    notices: Arc<Mutex<Vec<String>>>,
}

impl Client {
    fn refuse(&self, why: String) -> Result<bool, russh::Error> {
        if let Ok(mut slot) = self.refusal.lock() {
            *slot = Some(why);
        }
        Ok(false)
    }
}

impl Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            PublicKeyOrCertificate::Certificate(_) => {
                return self.refuse(
                    "The SSH server offered a host certificate, which LiteDB cannot verify yet."
                        .into(),
                );
            }
        };

        match keys::check_known_hosts(&self.host, self.port, key) {
            Ok(true) => return Ok(true),
            Err(keys::Error::KeyChanged { line }) => {
                return self.refuse(format!(
                    "The SSH host key for {} does not match line {line} of ~/.ssh/known_hosts. \
                     Someone may be intercepting the connection. If the server was rebuilt, \
                     remove the old key and connect again.",
                    self.host
                ));
            }
            _ => {}
        }

        match keys::check_known_hosts_path(&self.host, self.port, key, &self.known_hosts) {
            Ok(true) => Ok(true),
            Err(keys::Error::KeyChanged { .. }) => self.refuse(format!(
                "The SSH host key for {} changed since LiteDB first connected. Someone may be \
                 intercepting the connection. If the server was rebuilt, delete it from {}.",
                self.host,
                self.known_hosts.display()
            )),
            _ => {
                let _ = keys::known_hosts::learn_known_hosts_path(
                    &self.host,
                    self.port,
                    key,
                    &self.known_hosts,
                );
                if let Ok(mut notices) = self.notices.lock() {
                    notices.push(format!(
                        "First SSH connection to {}: trusted host key {}.",
                        self.host,
                        key.fingerprint(HashAlg::Sha256)
                    ));
                }
                Ok(true)
            }
        }
    }
}

pub struct SshTunnel {
    pub local_port: u16,
    pub notices: Vec<String>,
    task: tokio::task::JoinHandle<()>,
}

impl SshTunnel {
    pub async fn open(
        config: &SshConfig,
        target_host: &str,
        target_port: u16,
        known_hosts: PathBuf,
    ) -> Result<Self, String> {
        let host = config.host.trim().to_string();
        let refusal = Arc::new(Mutex::new(None));
        let notices = Arc::new(Mutex::new(Vec::new()));
        let client = Client {
            host: host.clone(),
            port: config.port,
            known_hosts,
            refusal: refusal.clone(),
            notices: notices.clone(),
        };
        let ssh_config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            ..Default::default()
        });

        let connect = client::connect(ssh_config, (host.as_str(), config.port), client);
        let mut handle = match tokio::time::timeout(Duration::from_secs(20), connect).await {
            Err(_) => {
                return Err(format!(
                    "Timed out reaching the SSH server {host}:{}.",
                    config.port
                ))
            }
            Ok(Err(e)) => {
                let why = refusal.lock().ok().and_then(|mut r| r.take());
                return Err(why.unwrap_or_else(|| format!("SSH connection failed: {e}")));
            }
            Ok(Ok(handle)) => handle,
        };

        authenticate(&mut handle, config).await?;

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("Could not open the tunnel's local port: {e}"))?;
        let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

        let session = Arc::new(handle);
        let target_host = target_host.trim().to_string();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, peer) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(_) => break,
                };
                let session = session.clone();
                let host = target_host.clone();
                tokio::spawn(async move {
                    match session
                        .channel_open_direct_tcpip(
                            host,
                            target_port as u32,
                            peer.ip().to_string(),
                            peer.port() as u32,
                        )
                        .await
                    {
                        Ok(channel) => {
                            let mut stream = channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                        }
                        Err(e) => log::warn!("SSH tunnel could not open a channel: {e}"),
                    }
                });
            }
        });

        let notices = notices.lock().map(|n| n.clone()).unwrap_or_default();
        Ok(Self {
            local_port,
            notices,
            task,
        })
    }

    pub fn shutdown(&self) {
        self.task.abort();
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// `~/.ssh/id_ed25519` → the home directory, as a shell would.
fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

async fn authenticate(handle: &mut Handle<Client>, config: &SshConfig) -> Result<(), String> {
    let user = config.username.trim().to_string();
    if user.is_empty() {
        return Err("Enter the SSH username.".into());
    }
    let accepted = match config.auth.as_str() {
        "password" => handle
            .authenticate_password(user, config.password.clone().unwrap_or_default())
            .await
            .map_err(|e| e.to_string())?
            .success(),
        "key" => {
            let path = config
                .private_key_path
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or("Choose the private key file for SSH.")?;
            let passphrase = config.passphrase.as_deref().filter(|p| !p.is_empty());
            let key =
                keys::load_secret_key(expand_home(path), passphrase).map_err(|e| match e {
                    keys::Error::KeyIsEncrypted => {
                        "The SSH key is protected by a passphrase. Enter it.".to_string()
                    }
                    other => format!("Could not read the SSH key: {other}"),
                })?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|e| e.to_string())?
                .flatten();
            handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| e.to_string())?
                .success()
        }
        "agent" => agent_auth(handle, &user).await?,
        other => return Err(format!("Unknown SSH authentication method \"{other}\".")),
    };
    if accepted {
        Ok(())
    } else {
        Err(match config.auth.as_str() {
            "password" => "The SSH server rejected the username or password.",
            "key" => "The SSH server rejected the key.",
            _ => "The SSH server rejected every key the agent offered.",
        }
        .into())
    }
}

#[cfg(unix)]
async fn agent_auth(handle: &mut Handle<Client>, user: &str) -> Result<bool, String> {
    let agent = keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| format!("Could not reach an SSH agent through SSH_AUTH_SOCK: {e}"))?;
    try_agent(handle, user, agent).await
}

#[cfg(windows)]
async fn agent_auth(handle: &mut Handle<Client>, user: &str) -> Result<bool, String> {
    match keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await
    {
        Ok(agent) => try_agent(handle, user, agent).await,
        Err(_) => {
            let agent = keys::agent::client::AgentClient::connect_pageant()
                .await
                .map_err(|e| {
                    format!(
                        "Could not reach an SSH agent (the OpenSSH agent service or Pageant): {e}"
                    )
                })?;
            try_agent(handle, user, agent).await
        }
    }
}

async fn try_agent<S>(
    handle: &mut Handle<Client>,
    user: &str,
    mut agent: keys::agent::client::AgentClient<S>,
) -> Result<bool, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("The SSH agent did not list its keys: {e}"))?;
    if identities.is_empty() {
        return Err("The SSH agent has no keys loaded.".into());
    }
    let rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    for identity in identities {
        let key = identity.public_key().into_owned();
        let hash = if key.algorithm().is_rsa() {
            rsa_hash
        } else {
            None
        };
        if let Ok(result) = handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
        {
            if result.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_is_expanded_in_key_paths() {
        std::env::set_var("HOME", "/home/test");
        assert_eq!(
            expand_home("~/.ssh/id_ed25519"),
            PathBuf::from("/home/test").join(".ssh/id_ed25519")
        );
        assert_eq!(expand_home("/abs/key"), PathBuf::from("/abs/key"));
    }
}
