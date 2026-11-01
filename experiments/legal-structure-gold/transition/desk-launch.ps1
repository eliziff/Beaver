param([string]$Script, [string]$Log)
# A job started apart from the ssh session that launches it, so a dropped connection does not end it.
$started = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd.exe /c $Script > $Log 2>&1"; CurrentDirectory = 'C:\Users\elias\fable\joint' }
'return {0}, pid {1}' -f $started.ReturnValue, $started.ProcessId
