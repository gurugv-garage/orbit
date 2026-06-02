# Build all STLs from OpenSCAD sources.
#   make            -> build everything into stl/
#   make clean      -> remove stl/*.stl
#
# Requires: openscad on PATH (`brew install openscad`).

SCAD_DIR := scad
STL_DIR  := stl

PARTS := base_lower base_upper leg_shaft \
         trunk_back trunk_front neck_stub \
         head_back head_front \
         shoulder_bracket arm

STLS := $(addprefix $(STL_DIR)/,$(addsuffix .stl,$(PARTS)))

all: $(STLS)

$(STL_DIR)/%.stl: $(SCAD_DIR)/%.scad $(SCAD_DIR)/params.scad $(SCAD_DIR)/util.scad
	@mkdir -p $(STL_DIR)
	openscad --export-format binstl -o $@ $<

clean:
	rm -f $(STL_DIR)/*.stl

.PHONY: all clean
