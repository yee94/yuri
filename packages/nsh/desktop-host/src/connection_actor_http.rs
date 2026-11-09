//! Raw sensitive sync jobs on the original actor/Network, never the JS request decoder.
use super::*;
use crate::connection_actor_http_port::{self as raw, Authority, Error, Response};

pub(super) struct Pending {
    call: raw::Call,
    binding: connection_actor_storage::Binding,
    candidate: Connection,
    current: crate::connection_actor_port::Current,
    binary: bool,
    limit: usize,
    mutation: bool,
}
impl Pending {
    pub fn valid(&self, actor: &Actor) -> bool {
        self.call.current()
            && (self.current)()
            && !actor.quarantined
            && !actor.native_poison.load(Ordering::Acquire)
            && actor.services.live()
            && actor.native_receipts.contains(&self.binding.receipt)
            && actor.binding_matches(&self.binding)
            && actor.state.as_ref().is_some_and(|s| {
                s.native.instances.contains(&self.binding.target)
                    && s.connections.iter().any(|c| {
                        c.id == self.candidate.id
                            && c.url == self.candidate.url
                            && c.authorization == self.candidate.authorization
                            && c.token == self.candidate.token
                    })
            })
    }
    pub fn dispatched(&self) -> raw::Result<()> {
        self.call.dispatch()
    }
    pub fn limit(&self) -> usize {
        self.limit
    }
    pub fn fail(self, error: Error) {
        let error = self.call.failure(error);
        self.call.finish(Err(error));
    }
    pub fn head(&self, head: &HttpHead) -> Result<()> {
        if !(100..600).contains(&head.status)
            || (300..400).contains(&head.status)
            || head.redirected
        {
            return Err("raw_sync_response_invalid".into());
        }
        let lengths: Vec<_> = head
            .headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .collect();
        if lengths.len() > 1
            || lengths
                .iter()
                .any(|(_, v)| v.parse::<usize>().map_or(true, |n| n > self.limit))
        {
            return Err("raw_sync_response_limit".into());
        }
        let expected = if (200..300).contains(&head.status) && self.binary {
            "application/octet-stream"
        } else {
            "application/json"
        };
        if !mime(head).eq_ignore_ascii_case(expected) {
            return Err("raw_sync_response_invalid".into());
        }
        Ok(())
    }
    pub fn finish(self, head: Option<HttpHead>, body: Vec<u8>) {
        let Some(head) = head else {
            self.fail(Error::Unavailable);
            return;
        };
        if self.head(&head).is_err()
            || head
                .headers
                .iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .any(|(_, v)| v.parse::<usize>().ok() != Some(body.len()))
        {
            self.fail(Error::Unavailable);
            return;
        }
        if self.mutation && !(200..300).contains(&head.status) {
            self.fail(Error::Unknown);
            return;
        }
        self.call.finish(Ok(Response {
            status: head.status,
            body,
        }));
    }
}
impl Actor {
    pub(super) fn native_http(&mut self, work: raw::Pending) {
        let raw::Pending {
            authority,
            request,
            current,
            call,
        } = work;
        let result: raw::Result<_> = (|| {
            call.begin()?;
            if !current() {
                return Err(Error::Cancelled);
            }
            if self.quarantined || self.native_poison.load(Ordering::Acquire) {
                return Err(Error::CommitUnknown);
            }
            if !self.services.live() {
                return Err(Error::Unavailable);
            }
            request.validate()?;
            let Authority::Remote(committed) = authority else {
                return Err(Error::Unavailable);
            };
            self.load().map_err(|e| {
                if vault::invalidates_authority(&e) {
                    Error::CommitUnknown
                } else {
                    Error::Unavailable
                }
            })?;
            let binding = self
                .state()
                .native
                .bindings
                .iter()
                .find(|b| {
                    b.connection_id == committed.connection_id && b.receipt == committed.receipt
                })
                .cloned()
                .ok_or(Error::Stale)?;
            if !self.state().native.instances.contains(&binding.target)
                || !self.native_receipts.contains(&binding.receipt)
            {
                return Err(Error::Stale);
            }
            let candidate = self
                .state()
                .connections
                .iter()
                .find(|c| {
                    c.id == committed.connection_id && c.authorization == binding.authorization
                })
                .cloned()
                .ok_or(Error::Stale)?;
            if candidate.token.is_empty() {
                return Err(Error::Authentication);
            }
            if self.jobs.len() >= MAX_HTTP {
                return Err(Error::Busy);
            }
            let (method, path, binary, limit) = request.wire();
            policy::route(path, false).map_err(|_| Error::Invalid)?;
            let mutation = request.mutation();
            let mut wire = HttpRequest::new(method, format!("{}{path}", candidate.url))
                .header("Authorization", format!("Bearer {}", candidate.token))
                .header(
                    "Accept",
                    if binary {
                        "application/octet-stream"
                    } else {
                        "application/json"
                    },
                )
                .header("Cache-Control", "no-store");
            wire.follow_redirects = false;
            if let Some(body) = request.body() {
                wire = wire
                    .header("Content-Type", "application/octet-stream")
                    .body(body);
            }
            if !call.current() || !current() {
                return Err(Error::Cancelled);
            }
            Ok((
                binding,
                candidate,
                path.to_owned(),
                wire,
                binary,
                limit,
                mutation,
            ))
        })();
        match result {
            Ok((binding, candidate, path, request, binary, limit, mutation)) => self.start_job(
                path,
                request,
                Completion::NativeHttp(Box::new(Pending {
                    call,
                    binding,
                    candidate,
                    current,
                    binary,
                    limit,
                    mutation,
                })),
                HostReply::default(),
            ),
            Err(error) => call.finish(Err(error)),
        }
    }
    pub(super) fn retire_native_http_stale(&mut self) {
        let stale: Vec<_> = self
            .jobs
            .iter()
            .filter(
                |(_, job)| matches!(&job.completion, Completion::NativeHttp(p) if !p.valid(self)),
            )
            .map(|(ticket, _)| *ticket)
            .collect();
        for ticket in stale {
            if let Some(job) = self.jobs.remove(&ticket) {
                self.fail_job(job, "raw_sync_authority_stale");
            }
        }
    }
}
