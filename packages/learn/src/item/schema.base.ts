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
        "pattern": "^(cka|ckad)\\.[a-z]+\\.[a-z0-9-]+$"
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
      "type": "string",
      "minLength": 1
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
      "oneOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "array",
          "minItems": 1,
          "items": {
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
        }
      ]
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
