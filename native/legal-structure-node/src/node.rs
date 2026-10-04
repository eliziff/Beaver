//! Node-API binding over `dispatch`: the engine's operations, called the way the browser's
//! WebAssembly runtime calls them. `callAsync` runs one off the JS thread.

use crate::{dispatch, engine};
use napi::bindgen_prelude::{AsyncTask, Buffer, FnArgs, Function};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Task};
use napi_derive::napi;

#[napi_derive::module_init]
fn init() {
    engine::install_structure_analysis();
}

/// One operation, run now: a dispatch request in, its reply out.
#[napi]
pub fn call(request: Buffer) -> Buffer {
    dispatch::call(&request, None).into()
}

type ProgressFunction =
    ThreadsafeFunction<FnArgs<(u32, u32)>, (), FnArgs<(u32, u32)>, napi::Status, false, true>;

pub struct CallTask {
    request: Buffer,
    progress: Option<ProgressFunction>,
}

impl Task for CallTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let report = self.progress.as_ref().map(|progress| move |done: usize, total: usize| {
            progress.call(FnArgs::from((done as u32, total as u32)), ThreadsafeFunctionCallMode::NonBlocking);
        });
        let report = report.as_ref().map(|report| report as &(dyn Fn(usize, usize) + Sync));
        Ok(dispatch::call(&self.request, report))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output.into())
    }
}

/// `call`, off the JS thread. `progress(recognized, total)` follows OCR page window by window.
#[napi(js_name = "callAsync")]
pub fn call_async(
    request: Buffer,
    progress: Option<Function<'_, FnArgs<(u32, u32)>, ()>>,
) -> napi::Result<AsyncTask<CallTask>> {
    Ok(AsyncTask::new(CallTask {
        request,
        progress: progress
            .map(|progress| progress.build_threadsafe_function().callee_handled::<false>().weak::<true>().build())
            .transpose()?,
    }))
}
