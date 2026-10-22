' Start a program with no console window and wait for it. Used by the MEMO scheduled task.
' usage: wscript //B //Nologo run-hidden.vbs "<exe>" [args...]
' Waiting lets Task Scheduler see the real duration and exit code, and keeps
' "MultipleInstances IgnoreNew" meaningful.
Option Explicit
Dim shell, args, cmd, i, rc
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments
If args.Count = 0 Then WScript.Quit 1
cmd = ""
For i = 0 To args.Count - 1
  cmd = cmd & """" & args(i) & """"
  If i < args.Count - 1 Then cmd = cmd & " "
Next
' 0 = hidden window, True = wait for exit
rc = shell.Run(cmd, 0, True)
WScript.Quit rc
