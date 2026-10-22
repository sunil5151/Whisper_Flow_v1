' Start a program with no console window. Used by the MEMO scheduled task.
' usage: wscript //B //Nologo run-hidden.vbs "<exe>" [args...]
Option Explicit
Dim shell, args, cmd, i
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments
If args.Count = 0 Then WScript.Quit 1
cmd = ""
For i = 0 To args.Count - 1
  cmd = cmd & """" & args(i) & """"
  If i < args.Count - 1 Then cmd = cmd & " "
Next
' 0 = hidden window, False = do not wait
shell.Run cmd, 0, False
WScript.Quit 0
