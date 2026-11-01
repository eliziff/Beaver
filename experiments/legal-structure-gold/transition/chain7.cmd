@echo off
rem Tier 0 on grader-next7 with the joint solve (long7.cmd), then tier 1 (tiers.cmd), one after the other.
call C:\Users\elias\fable\joint\long7.cmd
echo %DATE% %TIME% long7 ended %ERRORLEVEL%>> C:\Users\elias\fable\transition5\stages.log
call C:\Users\elias\fable\joint\tiers.cmd
