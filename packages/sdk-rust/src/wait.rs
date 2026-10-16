use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use crate::http::BoxFuture;
use crate::types::{ApprovalData, ApprovalQuestion};

/// How often to ask, as the wait gets longer.
///
/// The first is deliberately quick: the approvals that take two seconds are
/// the ones somebody is watching, and a client whose first look is two seconds
/// away makes an instant decision feel like a slow one. After a few polls the
/// schedule is somebody's afternoon, not a progress bar.
pub const POLL_SCHEDULE: [Duration; 7] = [
    Duration::from_millis(250),
    Duration::from_millis(750),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

/// Development mode: the approver is imaginary and instant, so keep up.
pub(crate) const FAST_POLL_SCHEDULE: [Duration; 4] =
    [Duration::from_millis(10), Duration::from_millis(25), Duration::from_millis(50), Duration::from_millis(100)];

/// Answers a question the approver asked, without leaving the wait. Return
/// `Some(answer)` and it is posted; `None` leaves it for a person.
pub type QuestionHandler =
    Arc<dyn Fn(ApprovalQuestion, ApprovalData) -> BoxFuture<'static, Option<String>> + Send + Sync>;

/// Wrap an async closure as a [`QuestionHandler`].
///
/// ```
/// let handler = deliverd::on_question(|question, _approval| async move {
///     Some(format!("Yes: {}", question.question))
/// });
/// ```
pub fn on_question<F, Fut>(handler: F) -> QuestionHandler
where
    F: Fn(ApprovalQuestion, ApprovalData) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Option<String>> + Send + 'static,
{
    Arc::new(move |question, approval| Box::pin(handler(question, approval)))
}

/// Called after every poll with the latest snapshot.
pub type OnPoll<T> = Arc<dyn Fn(&T) + Send + Sync>;

/// How a wait behaves. Every field is optional.
pub struct WaitOptions<T> {
    /// Give up after this long and return a `timeout` error. Without one the
    /// wait ends when the request does, which is when it expires.
    pub timeout: Option<Duration>,
    /// Called after every poll, for a progress line.
    pub on_poll: Option<OnPoll<T>>,
    /// How long between polls, as the wait lengthens. Rarely worth changing.
    pub poll_intervals: Option<Vec<Duration>>,
    /// Approvals only: answer the approver's questions inside the wait.
    /// Without one a question simply sits there until a person answers it.
    pub on_question: Option<QuestionHandler>,
}

impl<T> Default for WaitOptions<T> {
    fn default() -> Self {
        Self { timeout: None, on_poll: None, poll_intervals: None, on_question: None }
    }
}

impl<T> Clone for WaitOptions<T> {
    fn clone(&self) -> Self {
        Self {
            timeout: self.timeout,
            on_poll: self.on_poll.clone(),
            poll_intervals: self.poll_intervals.clone(),
            on_question: self.on_question.clone(),
        }
    }
}

impl<T> WaitOptions<T> {
    pub fn timeout(mut self, value: Duration) -> Self {
        self.timeout = Some(value);
        self
    }
    pub fn on_poll(mut self, value: impl Fn(&T) + Send + Sync + 'static) -> Self {
        self.on_poll = Some(Arc::new(value));
        self
    }
    pub fn poll_intervals(mut self, value: Vec<Duration>) -> Self {
        self.poll_intervals = Some(value);
        self
    }
    pub fn on_question(mut self, value: QuestionHandler) -> Self {
        self.on_question = Some(value);
        self
    }
}

/// The poll loop's clock: when to look next, and when to stop.
pub(crate) struct Poller {
    deadline: Option<Instant>,
    schedule: Vec<Duration>,
    poll: usize,
}

impl Poller {
    pub fn new<T>(options: &WaitOptions<T>) -> Self {
        Self {
            deadline: options.timeout.map(|t| Instant::now() + t),
            schedule: options.poll_intervals.clone().unwrap_or_else(|| POLL_SCHEDULE.to_vec()),
            poll: 0,
        }
    }

    pub fn expired(&self) -> bool {
        self.deadline.is_some_and(|d| Instant::now() >= d)
    }

    /// Sleep until the next poll, never past the deadline.
    pub async fn tick(&mut self) {
        let base = self
            .schedule
            .get(self.poll.min(self.schedule.len().saturating_sub(1)))
            .copied()
            .unwrap_or(Duration::from_secs(60));
        self.poll += 1;
        // ±25% jitter, so a hundred agents started by the same cron do not
        // arrive together.
        let delay = base.mul_f64(0.75 + fastrand::f64() * 0.5);
        let delay = match self.deadline {
            Some(deadline) => delay.min(deadline.saturating_duration_since(Instant::now())),
            None => delay,
        };
        tokio::time::sleep(delay).await;
    }
}
