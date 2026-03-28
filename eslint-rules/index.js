export const rules = {
  'require-scratch-translate-getinfo': {
    meta: {
      type: 'problem',
      docs: {
        description: 'Require Scratch.translate(...) for string literals inside getInfo() (except id)',
        recommended: false,
      },
      schema: [],
      messages: {
        missingTranslate: 'String literal in getInfo() should be wrapped with Scratch.translate()',
      },
    },
    create(context) {
      // helper to check object expressions recursively
      function checkObject(node) {
        if (!node || node.type !== 'ObjectExpression') return;
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') continue;
          const key = prop.key && (prop.key.name || (prop.key.value));
          const val = prop.value;

          // Skip id property entirely
          if (key === 'id') continue;

          if (!val) continue;

          if (val.type === 'Literal' && typeof val.value === 'string') {
            context.report({ node: val, messageId: 'missingTranslate' });
          } else if (val.type === 'TemplateLiteral') {
            // Only report if there are no expressions (pure string)
            if (val.expressions.length === 0) {
              context.report({ node: val, messageId: 'missingTranslate' });
            }
          } else if (val.type === 'ObjectExpression') {
            checkObject(val);
          } else if (val.type === 'ArrayExpression') {
            for (const el of val.elements) {
              if (!el) continue;
              if (el.type === 'Literal' && typeof el.value === 'string') {
                context.report({ node: el, messageId: 'missingTranslate' });
              } else if (el.type === 'TemplateLiteral' && el.expressions.length === 0) {
                context.report({ node: el, messageId: 'missingTranslate' });
              } else if (el.type === 'ObjectExpression') {
                checkObject(el);
              }
            }
          } else if (val.type === 'CallExpression') {
            // If already wrapped, ensure it's Scratch.translate
            const callee = val.callee;
            if (
              callee &&
              callee.type === 'MemberExpression' &&
              callee.object &&
              callee.object.type === 'Identifier' &&
              callee.object.name === 'Scratch' &&
              ((callee.property.type === 'Identifier' && callee.property.name === 'translate') ||
                (callee.property.type === 'Literal' && callee.property.value === 'translate'))
            ) {
              // OK
            } else {
              // e.g., other function calls returning strings - we won't force translate here
            }
          }
        }
      }

      // Given a function node, find return statements that return object expressions
      function checkFunctionNode(fnNode) {
        if (!fnNode.body) return;
        const body = fnNode.body.type === 'BlockStatement' ? fnNode.body.body : [fnNode.body];
        for (const stmt of body) {
          if (!stmt) continue;
          if (stmt.type === 'ReturnStatement' && stmt.argument) {
            if (stmt.argument.type === 'ObjectExpression') {
              checkObject(stmt.argument);
            }
          }
        }
      }

      return {
        FunctionDeclaration(node) {
          if (node.id && node.id.name === 'getInfo') {
            checkFunctionNode(node);
          }
        },
        FunctionExpression(node) {
          // check assignments like const getInfo = function() { }
          const parent = node.parent;
          if (parent && parent.type === 'Property' && (parent.key.name === 'getInfo' || parent.key.value === 'getInfo')) {
            checkFunctionNode(node);
          } else if (parent && parent.type === 'VariableDeclarator' && parent.id && parent.id.name === 'getInfo') {
            checkFunctionNode(node);
          }
        },
        ArrowFunctionExpression(node) {
          const parent = node.parent;
          if (parent && parent.type === 'Property' && (parent.key.name === 'getInfo' || parent.key.value === 'getInfo')) {
            checkFunctionNode(node);
          } else if (parent && parent.type === 'VariableDeclarator' && parent.id && parent.id.name === 'getInfo') {
            checkFunctionNode(node);
          }
        },
        MethodDefinition(node) {
          const key = node.key && (node.key.name || node.key.value);
          if (key === 'getInfo') {
            const fn = node.value || node;
            checkFunctionNode(fn);
          }
        },
        Property(node) {
          const key = node.key && (node.key.name || node.key.value);
          if (key === 'getInfo' && (node.value && (node.value.type === 'FunctionExpression' || node.value.type === 'ArrowFunctionExpression'))) {
            checkFunctionNode(node.value);
          }
        },
      };
    },
  },
};

export default { rules };