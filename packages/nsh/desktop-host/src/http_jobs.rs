//! Receipt-owned ordinary HTTP on the original actor; never SSE, resource or PTY cancellation.
use super::*;
impl Actor {
    pub(super) fn http_capabilities(&self, input: &Value) -> Result<Value> {
        policy::keys(input, &[], &[])?;
        Ok(
            json!({"version":1,"request":true,"cancel":true,"windowID":self.services.window_id()?,"maxRequests":http_receipts::MAX_REQUESTS,"maxConcurrent":MAX_HTTP,"timeoutMs":30000}),
        )
    }
    pub(super) fn http_request(&mut self, input: Value, reply: HostReply) {
        let result = (|| -> Result<_> {
            let key = http_receipts::Key::parse(&input, &self.services.window_id()?, true)?;
            self.state().admit(Some(&key.scope), true)?;
            let path = policy::string(&input, "path")?.to_owned();
            let method = match input.get("method") {
                None => "GET",
                Some(Value::String(s)) => s,
                _ => return Err("invalid_http_method".into()),
            };
            if !METHODS.contains(&method) {
                return Err("invalid_http_method".into());
            }
            let request = make_request(
                &self.state().current()?,
                &path,
                method,
                input.get("body"),
                false,
            )?;
            if !self.http_receipts.reserve(&key)? {
                return Err("http_request_cancelled".into());
            }
            Ok((key, path, request, writer::grant(&input)?))
        })();
        match result {
            Ok((key, path, request, writer_grant)) => self.start_job(
                path,
                request,
                Completion::HttpReceipt {
                    key,
                    ticket: 0,
                    writer_grant,
                },
                reply,
            ),
            Err(error) => reply.reject(error),
        }
    }
    pub(super) fn http_cancel(&mut self, input: &Value) -> Result<Value> {
        let key = http_receipts::Key::parse(input, &self.services.window_id()?, false)?;
        self.state().admit(Some(&key.scope), true)?;
        if let Some(ticket) = self.http_receipts.cancel(&key)?
            && let Some(job) = self.jobs.remove(&ticket)
        {
            if matches!(&job.completion,Completion::HttpReceipt{key:owned,ticket:bound,..} if owned==&key&&*bound==ticket)
            {
                self.fail_job(job, "http_request_cancelled");
            } else {
                self.jobs.insert(ticket, job);
                return Err("http_receipt_stale".into());
            }
        }
        Ok(json!({"ok":true}))
    }
}
