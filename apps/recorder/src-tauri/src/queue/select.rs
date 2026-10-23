//! Which recordings a connection may touch. A token goes only to the install
//! it was issued for, and only for recordings of the user it belongs to.
//! The uploader and the status poll choose through these functions.

use super::state::{Owner, RecordingState, Status};
use chrono::{DateTime, Utc};
use serde::Serialize;

/// A connection: the install's origin and the user the token belongs to.
#[derive(Debug, Clone, PartialEq)]
pub struct Connection<'a> {
    pub host: &'a str,
    pub user: &'a Owner,
}

/// Same install, same user.
pub fn belongs(r: &RecordingState, c: &Connection) -> bool {
    r.host == c.host && r.owner.as_ref().is_some_and(|o| o.user_id == c.user.user_id)
}

/// The oldest recording due for an upload with this connection.
pub fn next_upload<'q>(queue: &'q [RecordingState], c: &Connection, now: DateTime<Utc>) -> Option<&'q RecordingState> {
    queue.iter().filter(|r| r.due(now) && belongs(r, c)).min_by_key(|r| r.started_at)
}

/// Recordings confirmed since `since` whose server status may still change.
pub fn status_targets<'q>(queue: &'q [RecordingState], c: &Connection, since: DateTime<Utc>) -> Vec<&'q RecordingState> {
    queue
        .iter()
        .filter(|r| r.status == Status::Confirmed && belongs(r, c))
        .filter(|r| r.confirmed_at.is_some_and(|at| at > since))
        .filter(|r| !matches!(r.server_status.as_deref(), Some("transcribed") | Some("failed")))
        .collect()
}

/// Why a waiting recording does not upload with the current connection.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Blocked {
    /// Recorded for another install: "Connect to <host> to upload".
    OtherHost { host: String },
    /// Recorded by another user of the same install: "Recorded by <email>".
    OtherUser { email: String },
    /// No owner yet (recovered, or recorded while disconnected): the user uploads it as themselves.
    NoOwner,
}

pub fn blocked(r: &RecordingState, c: Option<&Connection>) -> Option<Blocked> {
    if !r.is_unconfirmed() {
        return None;
    }
    let Some(owner) = &r.owner else { return Some(Blocked::NoOwner) };
    match c {
        Some(c) if c.host != r.host => Some(Blocked::OtherHost { host: label(&r.host) }),
        Some(c) if c.user.user_id == owner.user_id => None,
        Some(_) => Some(Blocked::OtherUser { email: owner.email.clone() }),
        None => Some(Blocked::OtherHost { host: label(&r.host) }),
    }
}

fn label(host: &str) -> String {
    host.split("://").nth(1).unwrap_or(host).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::state::Event;

    fn rec(id: &str, host: &str, user: &str) -> RecordingState {
        let mut r = RecordingState::new(id.into(), host.into(), id.into(), Utc::now());
        r.owner = Some(Owner { user_id: user.into(), email: format!("{user}@example.com") });
        r.apply(Event::Stopped { at: Utc::now(), duration_s: 1, sha256: "a".into(), size_bytes: 1 }, Utc::now());
        r
    }

    #[test]
    fn only_this_installs_and_this_users_recordings_are_chosen() {
        let me = Owner { user_id: "u1".into(), email: "u1@example.com".into() };
        let c = Connection { host: "https://a.example", user: &me };
        let queue = vec![rec("other-host", "https://b.example", "u1"), rec("other-user", "https://a.example", "u2"), rec("mine", "https://a.example", "u1")];
        assert_eq!(next_upload(&queue, &c, Utc::now()).map(|r| r.id.as_str()), Some("mine"));
        assert_eq!(blocked(&queue[0], Some(&c)), Some(Blocked::OtherHost { host: "b.example".into() }));
        assert_eq!(blocked(&queue[1], Some(&c)), Some(Blocked::OtherUser { email: "u2@example.com".into() }));
        assert_eq!(blocked(&queue[2], Some(&c)), None);
        let mut none = queue[2].clone();
        none.owner = None;
        assert_eq!(blocked(&none, Some(&c)), Some(Blocked::NoOwner));
        assert!(next_upload(&[none], &c, Utc::now()).is_none());
    }

    #[test]
    fn status_polls_follow_the_same_rule() {
        let me = Owner { user_id: "u1".into(), email: "u1@example.com".into() };
        let c = Connection { host: "https://a.example", user: &me };
        let mut queue = vec![rec("b", "https://b.example", "u1"), rec("a", "https://a.example", "u1")];
        for r in queue.iter_mut() {
            r.apply(Event::Confirmed { at: Utc::now() }, Utc::now());
        }
        let since = Utc::now() - chrono::Duration::hours(24);
        assert_eq!(status_targets(&queue, &c, since).iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a"]);
    }
}
