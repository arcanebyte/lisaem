/**************************************************************************************\
*                                                                                      *
*        DialogLog.h - log message boxes to stderr, and optionally skip them          *
*                                                                                      *
*        Every wxMessageBox call in the wx UI goes through LisaEmMessageBox, which     *
*        writes the title and text to stderr. With LISAEM_NO_DIALOGS set in the        *
*        environment it does not show the dialog and returns the answer of its         *
*        default button (Yes or OK, or No with wxNO_DEFAULT, Cancel with               *
*        wxCANCEL_DEFAULT), so LisaEm can run unattended from scripts.                 *
*                                                                                      *
*        This file is part of LisaEm and is under the same license (GPL v2 or later).  *
*                                                                                      *
\**************************************************************************************/

#ifndef DIALOGLOG_H
#define DIALOGLOG_H

#include <wx/msgdlg.h>
#include <cstdio>
#include <cstdlib>

static inline bool LisaEmNoDialogs(void)
{
    const char *e = getenv("LISAEM_NO_DIALOGS");
    return e != NULL && *e != '\0' && *e != '0';
}

// Returns the value ShowModal() would return for the dialog's default button.
static inline int LisaEmDialogDefault(long style)
{
    if ((style & wxCANCEL) && (style & wxCANCEL_DEFAULT))
        return wxID_CANCEL;
    if (style & wxYES_NO)
        return (style & wxNO_DEFAULT) ? wxID_NO : wxID_YES;
    return wxID_OK;
}

static inline void LisaEmLogDialog(const wxString &title, const wxString &text, bool shown)
{
    fprintf(stderr, "LisaEm dialog%s: [%s] %s\n", shown ? "" : " (not shown, LISAEM_NO_DIALOGS)",
            (const char *)title.utf8_str(), (const char *)text.utf8_str());
    fflush(stderr);
}

// wxMessageBox returns wxYES/wxNO/wxOK/wxCANCEL, not the wxID_ values.
static inline int LisaEmMessageBox(const wxString &message, const wxString &caption = wxMessageBoxCaptionStr,
                                   int style = wxOK | wxCENTRE, wxWindow *parent = NULL,
                                   int x = wxDefaultCoord, int y = wxDefaultCoord)
{
    bool show = !LisaEmNoDialogs();
    LisaEmLogDialog(caption, message, show);
    if (show)
        return wxMessageBox(message, caption, style, parent, x, y);
    switch (LisaEmDialogDefault(style))
    {
    case wxID_YES:
        return wxYES;
    case wxID_NO:
        return wxNO;
    case wxID_CANCEL:
        return wxCANCEL;
    }
    return wxOK;
}

// Use after all wx headers are included.
#define wxMessageBox LisaEmMessageBox

#endif
