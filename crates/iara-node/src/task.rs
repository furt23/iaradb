//! Work off the JS thread: a closure runs on libuv's pool and its result
//! resolves a Promise. An engine error rejects with its own `code` and a
//! panic becomes an `IaraError` instead of taking Node down.

use std::panic::{AssertUnwindSafe, catch_unwind};

use napi::bindgen_prelude::{AsyncTask, ToNapiValue, TypeName};
use napi::{Env, Error, JsError, Task};

use crate::error::{Result, invalid};

pub struct Job<T>(Option<Box<dyn FnOnce() -> Result<T> + Send>>);

impl<T: Send + ToNapiValue + TypeName + 'static> Task for Job<T> {
    type Output = Result<T>;
    type JsValue = T;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let f = self.0.take().expect("a task runs once");
        Ok(catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|p| Err(invalid(panic_message(&*p)))))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<T> {
        // the task API rejects with a `Status` code only: a rejection built from
        // the JS error object (which carries our `code`) goes through unchanged
        output.map_err(|e| Error::from(JsError::from(e).into_unknown(env)))
    }
}

pub fn spawn<T: Send + ToNapiValue + TypeName + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> AsyncTask<Job<T>> {
    AsyncTask::new(Job(Some(Box::new(f))))
}

pub fn panic_message(p: &(dyn std::any::Any + Send)) -> String {
    let msg = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned());
    format!("internal error (panic): {}", msg.unwrap_or_else(|| "unknown".into()))
}
