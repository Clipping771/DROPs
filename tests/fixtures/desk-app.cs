// A tiny Windows Forms app for the computer-use tests: a note box, a password box, Add, Delete all.
using System;
using System.Drawing;
using System.Windows.Forms;

public class DeskTestApp : Form {
  int count = 0;
  [STAThread] public static void Main() { Application.EnableVisualStyles(); Application.Run(new DeskTestApp()); }
  public DeskTestApp() {
    Text = "DROPs Desk Test"; ClientSize = new Size(420, 260); StartPosition = FormStartPosition.Manual; Location = new Point(80, 80);
    var note = new TextBox { Location = new Point(20, 20), Width = 370, AccessibleName = "Note" };
    var pass = new TextBox { Location = new Point(20, 60), Width = 370, UseSystemPasswordChar = true, AccessibleName = "Password" };
    var label = new Label { Location = new Point(20, 100), Width = 370, Text = "Count: 0" };
    var add = new Button { Location = new Point(20, 140), Width = 110, Height = 40, Text = "Add" };
    var del = new Button { Location = new Point(150, 140), Width = 110, Height = 40, Text = "Delete all" };
    add.Click += (s, e) => { count++; label.Text = "Count: " + count + (note.Text.Length > 0 ? " · " + note.Text : ""); };
    del.Click += (s, e) => { count = 0; label.Text = "Deleted"; };
    Controls.AddRange(new Control[] { note, pass, label, add, del });
  }
}
