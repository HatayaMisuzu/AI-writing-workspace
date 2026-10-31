/**
 * P3 发布包：开发用诊断接口（__devWalCheckpoint）的开关。
 * main 只在未打包（!app.isPackaged：开发 / vitest / e2e 直接跑 out/main/index.js）时，
 * 通过 webPreferences.additionalArguments 把这个参数追加到渲染进程的 process.argv；preload 见到它才暴露接口。
 * 打包版 main 不追加该参数、也不注册 IPC，所以用户在命令行自己加这个参数只会进入 main 进程 argv，
 * 不会出现在渲染进程，打不开该接口。没有环境变量开关。
 */
export const DEV_DIAGNOSTICS_ARG = '--inkstone-dev-diagnostics'
