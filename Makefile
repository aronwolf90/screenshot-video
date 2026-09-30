UUID = flameshot-gnome@aronwolf90.github.io
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES = extension.js overlay.js drawing.js recorder.js pinned.js prefs.js save-dialog.js \
	video-editor.js metadata.json stylesheet.css

.PHONY: all schemas install link uninstall zip check clean

all: schemas

schemas:
	glib-compile-schemas schemas/

check:
	@for f in extension.js overlay.js drawing.js recorder.js pinned.js prefs.js save-dialog.js \
		video-editor.js editor/*.js; do \
		node --experimental-default-type=module --check $$f && echo "ok  $$f"; \
	done

install: schemas
	mkdir -p $(INSTALL_DIR)
	cp -r $(FILES) editor icons schemas $(INSTALL_DIR)/
	@echo "Installed to $(INSTALL_DIR). Log out and back in, then run:"
	@echo "  gnome-extensions enable $(UUID)"

# Symlink the working tree instead of copying (development).
link: schemas
	mkdir -p $(dir $(INSTALL_DIR))
	rm -rf $(INSTALL_DIR)
	ln -s $(CURDIR) $(INSTALL_DIR)

uninstall:
	rm -rf $(INSTALL_DIR)

zip: schemas
	rm -f $(UUID).shell-extension.zip
	zip -r $(UUID).shell-extension.zip $(FILES) editor icons schemas -x 'schemas/*.xml~'

clean:
	rm -f $(UUID).shell-extension.zip
