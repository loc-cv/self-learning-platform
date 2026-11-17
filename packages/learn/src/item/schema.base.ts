// The parts of item.schema.json that are not catalogs: the item layout (docs/SCENARIO_FORMAT.md
// §2–§10). schema.ts adds the catalogs of checks, steps, faults and topologies from the registry.
// Edit here, then run `npm run content:schema` to rewrite docs/schema/item.schema.json.

import type { Json } from "@simlab/kernel";

export const ITEM_SCHEMA_BASE: { [key: string]: Json } = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://simlab.invalid/schema/item.schema.json",
  "title": "Simlab lab-like content item (lab, drill, incident)",
  "description": "Specified in docs/SCENARIO_FORMAT.md. The check, fault and step catalogs in $defs are the phase 00 catalog; from phase 09 they are generated from the plugin registry.",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[a-z0-9]+(\\.[a-z0-9]+(-[a-z0-9]+)*)+$"
    },
    "kind": {
      "enum": [
        "lab",
        "drill",
        "incident"
      ]
    },
    "title": {
      "type": "string",
      "minLength": 1
    },
    "skills": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "pattern": "^[a-z0-9]+(\\.[a-z0-9]+(-[a-z0-9]+)*)+$"
      }
    },
    "curriculum": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "pattern": "^[a-z0-9]+\\.[a-z0-9-]+\\.[a-z0-9-]+$"
      }
    },
    "difficulty": {
      "type": "integer",
      "minimum": 1,
      "maximum": 5
    },
    "targetMinutes": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "assist": {
      "description": "How much of the live view of the world an attempt may use: `full` (the X-ray with its \"why\" inspector and timeline), `view` (the X-ray without explanations) or `off`. The learner's global setting can lower it, never raise it. Default full.",
      "enum": [
        "off",
        "view",
        "full"
      ]
    },
    "world": {
      "type": "object",
      "properties": {
        "topology": {
          "type": "string",
          "minLength": 1
        },
        "topologyParams": {
          "type": "object"
        },
        "startTime": {
          "type": "string",
          "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
        },
        "entry": {
          "type": "object",
          "properties": {
            "machine": {
              "type": "string",
              "minLength": 1
            },
            "user": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "machine",
            "user"
          ],
          "additionalProperties": false
        },
        "params": {
          "type": "object",
          "propertyNames": {
            "pattern": "^[a-z][a-zA-Z0-9]*$"
          },
          "additionalProperties": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "pick": {
                    "type": "array",
                    "minItems": 2,
                    "uniqueItems": true,
                    "items": {
                      "type": [
                        "string",
                        "number",
                        "boolean"
                      ]
                    }
                  }
                },
                "required": [
                  "pick"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "int": {
                    "type": "object",
                    "properties": {
                      "min": {
                        "type": "integer"
                      },
                      "max": {
                        "type": "integer"
                      }
                    },
                    "required": [
                      "min",
                      "max"
                    ],
                    "additionalProperties": false
                  }
                },
                "required": [
                  "int"
                ],
                "additionalProperties": false
              }
            ]
          }
        },
        "images": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/image"
          }
        },
        "setup": {
          "$ref": "#/$defs/steps"
        }
      },
      "required": [
        "topology",
        "setup"
      ],
      "additionalProperties": false
    },
    "ticket": {
      "$ref": "#/$defs/prose"
    },
    "hints": {
      "type": "array",
      "minItems": 1,
      "items": {
        "oneOf": [
          {
            "type": "string",
            "minLength": 1
          },
          {
            "type": "object",
            "properties": {
              "text": {
                "type": "string",
                "minLength": 1
              },
              "when": {
                "$ref": "#/$defs/when"
              }
            },
            "required": [
              "text"
            ],
            "additionalProperties": false
          }
        ]
      }
    },
    "checks": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "#/$defs/check"
      }
    },
    "solutions": {
      "type": "array",
      "minItems": 1,
      "items": {
        "oneOf": [
          {
            "$ref": "#/$defs/steps"
          },
          {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "minLength": 1
              },
              "steps": {
                "$ref": "#/$defs/steps"
              },
              "when": {
                "$ref": "#/$defs/when"
              }
            },
            "required": [
              "name",
              "steps"
            ],
            "additionalProperties": false
          }
        ]
      }
    },
    "debrief": {
      "$ref": "#/$defs/prose"
    }
  },
  "required": [
    "id",
    "kind",
    "title",
    "skills",
    "curriculum",
    "difficulty",
    "targetMinutes",
    "world",
    "ticket",
    "hints",
    "checks",
    "solutions",
    "debrief"
  ],
  "additionalProperties": false,
  "$defs": {
    "prose": {
      "description": "Markdown, or a list of blocks of prose and figures (docs/SCENARIO_FORMAT.md \u00a710, \u00a711)",
      "oneOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/block"
          }
        }
      ]
    },
    "block": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "text": {
              "type": "string",
              "minLength": 1
            },
            "when": {
              "$ref": "#/$defs/when"
            }
          },
          "required": [
            "text"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "figure": {
              "$ref": "#/$defs/figure"
            },
            "when": {
              "$ref": "#/$defs/when"
            }
          },
          "required": [
            "figure"
          ],
          "additionalProperties": false
        }
      ]
    },
    "entityRef": {
      "type": "string",
      "pattern": "^[^/]+/.+$",
      "description": "`<Kind>/<name>` as the view names them; `*` matches any run of characters"
    },
    "focus": {
      "type": "object",
      "properties": {
        "scope": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string",
                "minLength": 1
              }
            }
          ]
        },
        "kinds": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "entities": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/entityRef"
          }
        },
        "system": {
          "type": "boolean"
        }
      },
      "additionalProperties": false,
      "minProperties": 1
    },
    "showItem": {
      "oneOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "object",
          "properties": {
            "fact": {
              "type": "string",
              "minLength": 1
            },
            "keys": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string",
                "minLength": 1
              }
            }
          },
          "required": [
            "fact",
            "keys"
          ],
          "additionalProperties": false
        }
      ]
    },
    "note": {
      "type": "object",
      "properties": {
        "on": {
          "$ref": "#/$defs/entityRef"
        },
        "text": {
          "type": "string",
          "minLength": 1
        },
        "divergence": {
          "type": "string",
          "pattern": "^DIV-[0-9]{3}$"
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false
    },
    "diagramNote": {
      "type": "object",
      "properties": {
        "on": {
          "type": "string",
          "description": "The id of a diagram entity"
        },
        "text": {
          "type": "string",
          "minLength": 1
        },
        "divergence": {
          "type": "string",
          "pattern": "^DIV-[0-9]{3}$"
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false
    },
    "figure": {
      "oneOf": [
        {
          "title": "view",
          "type": "object",
          "properties": {
            "kind": {
              "const": "view"
            },
            "caption": {
              "type": "string",
              "minLength": 1
            },
            "alt": {
              "type": "string",
              "minLength": 1
            },
            "of": {
              "enum": [
                "start",
                "solved",
                "now"
              ]
            },
            "focus": {
              "$ref": "#/$defs/focus"
            },
            "show": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/showItem"
              }
            },
            "highlight": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/entityRef"
              }
            },
            "notes": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/note"
              }
            }
          },
          "required": [
            "kind",
            "caption",
            "alt",
            "of"
          ],
          "additionalProperties": false
        },
        {
          "title": "compare",
          "type": "object",
          "properties": {
            "kind": {
              "const": "compare"
            },
            "caption": {
              "type": "string",
              "minLength": 1
            },
            "alt": {
              "type": "string",
              "minLength": 1
            },
            "left": {
              "type": "object",
              "properties": {
                "of": {
                  "enum": [
                    "start",
                    "solved",
                    "now"
                  ]
                },
                "title": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "of"
              ],
              "additionalProperties": false
            },
            "right": {
              "type": "object",
              "properties": {
                "of": {
                  "enum": [
                    "start",
                    "solved",
                    "now"
                  ]
                },
                "title": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "of"
              ],
              "additionalProperties": false
            },
            "focus": {
              "$ref": "#/$defs/focus"
            },
            "show": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/showItem"
              }
            },
            "highlight": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/entityRef"
              }
            },
            "notes": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/note"
              }
            }
          },
          "required": [
            "kind",
            "caption",
            "alt",
            "left",
            "right"
          ],
          "additionalProperties": false
        },
        {
          "title": "scene",
          "type": "object",
          "properties": {
            "kind": {
              "const": "scene"
            },
            "caption": {
              "type": "string",
              "minLength": 1
            },
            "alt": {
              "type": "string",
              "minLength": 1
            },
            "world": {
              "type": "object",
              "properties": {
                "topology": {
                  "type": "string"
                },
                "setup": {
                  "$ref": "#/$defs/steps"
                }
              },
              "required": [
                "setup"
              ],
              "additionalProperties": false
            },
            "frames": {
              "type": "array",
              "minItems": 2,
              "items": {
                "type": "object",
                "properties": {
                  "steps": {
                    "$ref": "#/$defs/steps"
                  },
                  "at": {
                    "description": "Draw the frame at the moment the trace records the first event since the previous frame that matches every part given (`*` matches any run of characters). After `steps`, time advances event by event until it does. The caption may quote the event's text as {{@cause}}.",
                    "type": "object",
                    "properties": {
                      "actor": {
                        "type": "string",
                        "minLength": 1
                      },
                      "about": {
                        "$ref": "#/$defs/entityRef"
                      },
                      "text": {
                        "type": "string",
                        "minLength": 1
                      },
                      "within": {
                        "$ref": "#/$defs/duration"
                      }
                    },
                    "minProperties": 1,
                    "additionalProperties": false
                  },
                  "caption": {
                    "type": "string",
                    "minLength": 1
                  },
                  "highlight": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "$ref": "#/$defs/entityRef"
                    }
                  },
                  "notes": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "$ref": "#/$defs/note"
                    }
                  }
                },
                "required": [
                  "caption"
                ],
                "additionalProperties": false
              }
            },
            "focus": {
              "$ref": "#/$defs/focus"
            },
            "show": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/showItem"
              }
            },
            "highlight": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/entityRef"
              }
            },
            "notes": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/note"
              }
            }
          },
          "required": [
            "kind",
            "caption",
            "alt",
            "frames"
          ],
          "additionalProperties": false
        },
        {
          "title": "diagram",
          "type": "object",
          "properties": {
            "kind": {
              "const": "diagram"
            },
            "caption": {
              "type": "string",
              "minLength": 1
            },
            "alt": {
              "type": "string",
              "minLength": 1
            },
            "entities": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[a-z][a-z0-9-]*$"
                  },
                  "shape": {
                    "enum": [
                      "host",
                      "scope",
                      "workload",
                      "process",
                      "endpoint",
                      "store",
                      "rule"
                    ]
                  },
                  "label": {
                    "type": "string",
                    "minLength": 1
                  },
                  "kind": {
                    "type": "string",
                    "minLength": 1
                  },
                  "container": {
                    "type": "string"
                  },
                  "state": {
                    "enum": [
                      "healthy",
                      "progressing",
                      "degraded",
                      "failed",
                      "unknown"
                    ]
                  },
                  "status": {
                    "type": "string",
                    "minLength": 1
                  },
                  "facts": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "label": {
                          "type": "string",
                          "minLength": 1
                        },
                        "value": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": [
                        "label",
                        "value"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "id",
                  "shape",
                  "label"
                ],
                "additionalProperties": false
              }
            },
            "relations": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "type": {
                    "enum": [
                      "owns",
                      "selects",
                      "routesTo",
                      "runsOn",
                      "mounts",
                      "uses"
                    ]
                  },
                  "from": {
                    "type": "string"
                  },
                  "to": {
                    "type": "string"
                  }
                },
                "required": [
                  "type",
                  "from",
                  "to"
                ],
                "additionalProperties": false
              }
            },
            "highlight": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string"
              }
            },
            "notes": {
              "type": "array",
              "minItems": 1,
              "items": {
                "$ref": "#/$defs/diagramNote"
              }
            }
          },
          "required": [
            "kind",
            "caption",
            "alt",
            "entities"
          ],
          "additionalProperties": false
        }
      ]
    },
    "when": {
      "type": "object",
      "minProperties": 1,
      "propertyNames": {
        "pattern": "^[a-z][a-zA-Z0-9]*$"
      },
      "additionalProperties": {
        "oneOf": [
          {
            "type": [
              "string",
              "number",
              "boolean"
            ]
          },
          {
            "type": "array",
            "items": {
              "type": [
                "string",
                "number",
                "boolean"
              ]
            },
            "minItems": 1
          }
        ]
      }
    },
    "duration": {
      "type": "string",
      "pattern": "^[0-9]+(ms|s|m|h|d)$"
    },
    "steps": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "#/$defs/step"
      }
    },
    "check": {
      "allOf": [
        {
          "$ref": "#/$defs/assertion"
        },
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$"
            },
            "title": {
              "type": "string",
              "minLength": 1
            },
            "assert": {},
            "with": {},
            "not": {},
            "within": {
              "type": "string",
              "pattern": "^[0-9]+(ms|s|m|h|d)$"
            },
            "weight": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "after": {
              "$ref": "#/$defs/steps"
            },
            "when": {
              "$ref": "#/$defs/when"
            }
          },
          "required": [
            "id",
            "title"
          ],
          "additionalProperties": false
        }
      ]
    },
    "image": {
      "type": "object",
      "properties": {
        "listen": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": {
              "port": {
                "type": "integer"
              },
              "protocol": {
                "enum": [
                  "tcp",
                  "http"
                ]
              }
            },
            "required": [
              "port",
              "protocol"
            ],
            "additionalProperties": false
          }
        },
        "routes": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "status": {
                "type": "integer"
              },
              "body": {
                "type": "string"
              }
            },
            "required": [
              "path",
              "status"
            ],
            "additionalProperties": false
          }
        },
        "requires": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "minLength": 1
              },
              "connect": {
                "type": "object",
                "properties": {
                  "host": {
                    "oneOf": [
                      {
                        "type": "string",
                        "minLength": 1
                      },
                      {
                        "type": "object",
                        "properties": {
                          "env": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "required": [
                          "env"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  },
                  "port": {
                    "oneOf": [
                      {
                        "type": "integer"
                      },
                      {
                        "type": "object",
                        "properties": {
                          "env": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "required": [
                          "env"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  }
                },
                "required": [
                  "host",
                  "port"
                ],
                "additionalProperties": false
              },
              "otherwise": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "mode": {
                        "const": "unhealthy"
                      },
                      "log": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "required": [
                      "mode",
                      "log"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "mode": {
                        "const": "exit"
                      },
                      "code": {
                        "type": "integer"
                      },
                      "after": {
                        "type": "string",
                        "pattern": "^[0-9]+(ms|s|m|h|d)$"
                      },
                      "log": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "required": [
                      "mode",
                      "code",
                      "after",
                      "log"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            },
            "required": [
              "name",
              "connect",
              "otherwise"
            ],
            "additionalProperties": false
          }
        },
        "startup": {
          "type": "object",
          "properties": {
            "after": {
              "type": "string",
              "pattern": "^[0-9]+(ms|s|m|h|d)$"
            },
            "log": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1
              }
            }
          },
          "required": [],
          "additionalProperties": false
        },
        "exit": {
          "type": "object",
          "properties": {
            "code": {
              "type": "integer"
            },
            "after": {
              "type": "string",
              "pattern": "^[0-9]+(ms|s|m|h|d)$"
            },
            "log": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1
              }
            }
          },
          "required": [
            "code",
            "after"
          ],
          "additionalProperties": false
        },
        "shell": {
          "type": "boolean"
        }
      },
      "required": [],
      "additionalProperties": false,
      "minProperties": 1
    }
  }
};
